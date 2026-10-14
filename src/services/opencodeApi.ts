import type {
  OcSession,
  OcTodo,
  OcMessage,
  OcPendingQuestionItem,
  OcPendingPermissionItem,
  OcPermissionReply,
} from '../types/opencode'
import { applySessionDemoOverlay } from '../caseStudy/applySessionDemoOverlay'
import { isCaseStudyDemoEnabled } from '../caseStudy'
import { normalizeSessionDirectory, sameDirectory } from '../utils/sessionFolders'
import { resolveVibeTraceDefaultModelRef } from '../config/opencodeDefaults'

/**
 * OpenCode HTTP base URL — injected at build time by `vite.config.ts`:
 * `VITE_OPENCODE_BASE` → else `OPENCODE_BASE` → else default port.
 *
 * In `.env.local`, either `VITE_OPENCODE_BASE` or `OPENCODE_BASE` may be set (aligned with memory-worker); when both differ, `VITE_OPENCODE_BASE` wins.
 */
function resolveOpencodeBase(): string {
  if (typeof __OPENCODE_HTTP_BASE__ !== 'undefined') {
    // Empty string means same-origin + Vite proxy (plugin mode)
    return __OPENCODE_HTTP_BASE__.replace(/\/$/, '')
  }
  return 'http://127.0.0.1:4096'
}

const BASE = resolveOpencodeBase()

/** Prevent OpenCode requests from hanging forever and leaving the UI loading; ≤0 disables timeout */
export function opencodeFetchTimeoutMs(): number {
  const raw = import.meta.env.VITE_OPENCODE_FETCH_TIMEOUT_MS
  if (typeof raw !== 'string') return 45_000
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) return 45_000
  if (n <= 0) return 0
  return n
}

/**
 * Attach a timeout signal to fetch (may be merged with an external AbortSignal).
 * On very old browsers without AbortSignal.timeout, falls back to no timeout.
 */
function fetchSignal(existing?: AbortSignal): AbortSignal | undefined {
  const ms = opencodeFetchTimeoutMs()
  if (!Number.isFinite(ms) || ms <= 0) return existing
  try {
    const deadline = AbortSignal.timeout(ms)
    if (!existing) return deadline
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([existing, deadline])
    }
    return deadline
  } catch {
    return existing
  }
}

/**
 * OpenCode `POST /session/:id/message` expects `model` as `{ providerID, modelID }`, not a `provider/model` string.
 */
function parseModelRefToBody(ref: string): { providerID: string; modelID: string } | undefined {
  const t = ref.trim()
  const i = t.indexOf('/')
  if (i <= 0 || i >= t.length - 1) return undefined
  const providerID = t.slice(0, i).trim()
  const modelID = t.slice(i + 1).trim()
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

/**
 * Matches OpenCode server auth docs: when `OPENCODE_SERVER_PASSWORD` is set every HTTP/SSE hop needs Basic auth.
 */
function basicAuthHeader(): Record<string, string> {
  const pwd = import.meta.env.VITE_OPENCODE_SERVER_PASSWORD
  if (typeof pwd !== 'string' || !pwd.trim()) return {}
  const user =
    typeof import.meta.env.VITE_OPENCODE_SERVER_USERNAME === 'string' &&
    import.meta.env.VITE_OPENCODE_SERVER_USERNAME.trim()
      ? import.meta.env.VITE_OPENCODE_SERVER_USERNAME.trim()
      : 'opencode'
  const raw = `${user}:${pwd}`
  const bytes = new TextEncoder().encode(raw)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return { Authorization: `Basic ${btoa(bin)}` }
}

function withDirectoryHeaders(base: Record<string, string>, directory?: string): Record<string, string> {
  const out = { ...base, ...basicAuthHeader() }
  if (directory) out['x-opencode-directory'] = directory
  return out
}

function normalizeDirectoryLike(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t) return null
  return t.replace(/\\/g, '/').replace(/\/+$/, '')
}

function extractProjectDirectory(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null
  const obj = item as Record<string, unknown>
  const candidates = [
    obj.worktree,
    obj.directory,
    obj.path,
    obj.root,
    obj.cwd,
    (obj.path as Record<string, unknown> | undefined)?.directory,
  ]
  for (const c of candidates) {
    const n = normalizeDirectoryLike(c)
    if (n) return n
  }
  return null
}

// ===== REST API =====

/** Recent sessions for the global sidebar overview (OpenCode default is 100). */
export const OPENCODE_SESSION_RECENT_LIMIT = 100

/**
 * Upper bound when loading full history for known / selected workspace directories.
 * OpenCode accepts `?limit=`; values above the server total are capped server-side.
 */
export const OPENCODE_SESSION_DIRECTORY_LIMIT = 5000

export type GetSessionsOptions = {
  /** Sent as `x-opencode-directory` and, when `directoryQuery` is omitted, as `?directory=`. */
  directory?: string
  /** Explicit `?directory=` value (e.g. native Windows path while header uses forward slashes). */
  directoryQuery?: string
  limit?: number
  /** When true, request root sessions only (`?roots=true`), matching OpenCode desktop. */
  roots?: boolean
}

function buildSessionListUrl(options?: GetSessionsOptions): string {
  const params = new URLSearchParams()
  if (options?.limit != null && Number.isFinite(options.limit) && options.limit > 0) {
    params.set('limit', String(Math.floor(options.limit)))
  }
  const directoryQuery = options?.directoryQuery ?? options?.directory
  if (directoryQuery) {
    params.set('directory', directoryQuery)
  }
  if (options?.roots) {
    params.set('roots', 'true')
  }
  const qs = params.toString()
  return `${BASE}/session${qs ? `?${qs}` : ''}`
}

export async function getSessions(options?: GetSessionsOptions): Promise<OcSession[]> {
  const url = buildSessionListUrl(options)
  const res = await fetch(url, {
    headers: withDirectoryHeaders({}, options?.directory),
    signal: fetchSignal(),
  })
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`)
  return res.json()
}

/**
 * Load all sessions for one workspace directory. Tries OpenCode `?directory=` when supported;
 * otherwise falls back to a high-limit global list filtered client-side (needed on some 1.4.x builds).
 */
export async function getSessionsForDirectory(
  directory: string,
  limit: number = OPENCODE_SESSION_DIRECTORY_LIMIT,
): Promise<OcSession[]> {
  const normalized = normalizeSessionDirectory(directory)
  if (!normalized) return []

  const queryVariants = Array.from(
    new Set([normalized, normalized.replace(/\//g, '\\'), directory.trim()].filter(Boolean)),
  )

  for (const directoryQuery of queryVariants) {
    try {
      const listed = await getSessions({
        directory: normalized,
        directoryQuery,
        limit,
        roots: true,
      })
      const matched = listed.filter((s) => sameDirectory(s.directory, normalized))
      if (matched.length > 0) return matched
    } catch {
      /* try next variant or fallback */
    }
  }

  const global = await getSessions({ limit })
  return global.filter((s) => sameDirectory(s.directory, normalized))
}

export async function getProjectDirectories(): Promise<string[]> {
  const set = new Set<string>()

  const pull = async (url: string, label: string) => {
    const res = await fetch(url, { headers: withDirectoryHeaders({}) })
    if (!res.ok) {
      throw new Error(`${label} failed: ${res.status}`)
    }
    const data = await res.json()
    const list = Array.isArray(data) ? data : [data]
    for (const item of list) {
      const dir = extractProjectDirectory(item)
      if (dir) set.add(dir)
    }
  }

  try {
    await pull(`${BASE}/project`, 'GET /project')
  } catch {
    /* ignore — optional endpoint */
  }
  try {
    await pull(`${BASE}/project/current`, 'GET /project/current')
  } catch {
    /* ignore — optional endpoint */
  }

  return [...set]
}

export async function getCurrentWorkspaceDirectory(): Promise<string | null> {
  const res = await fetch(`${BASE}/path`, { headers: withDirectoryHeaders({}) })
  if (!res.ok) {
    throw new Error(`GET /path failed: ${res.status}`)
  }
  const data = await res.json()
  if (typeof data === 'string') return normalizeDirectoryLike(data)
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    const dir =
      normalizeDirectoryLike(obj.directory) ||
      normalizeDirectoryLike(obj.path) ||
      normalizeDirectoryLike(obj.cwd) ||
      normalizeDirectoryLike(obj.root)
    if (dir) return dir
  }
  return null
}

export async function createSession(directory?: string): Promise<OcSession> {
  const url = `${BASE}/session`
  const headers = withDirectoryHeaders({ 'Content-Type': 'application/json' }, directory)
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.status} ${bodyText}`)
  }
  const trimmed = bodyText.trim()
  if (trimmed) {
    try {
      return JSON.parse(trimmed) as OcSession
    } catch {
      /* fall through to session list fallback */
    }
  }

  const list = await getSessions(directory ? { directory } : undefined)
  const sorted = [...list].sort((a, b) => b.time.updated - a.time.updated)
  const pick = sorted[0]
  if (!pick) {
    throw new Error(
      'Create session: empty response and no sessions returned for this directory. Check OpenCode server logs.',
    )
  }
  return pick
}

export async function updateSessionTitle(
  sessionId: string,
  title: string,
  directory?: string,
): Promise<OcSession> {
  const url = `${BASE}/session/${sessionId}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: withDirectoryHeaders({ 'Content-Type': 'application/json' }, directory),
    body: JSON.stringify({ title }),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`Failed to update session title: ${res.status} ${bodyText}`)
  }
  return JSON.parse(bodyText) as OcSession
}

export async function deleteSession(sessionId: string, directory?: string): Promise<void> {
  const url = `${BASE}/session/${sessionId}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: withDirectoryHeaders({}, directory),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`deleteSession failed: ${res.status} ${bodyText}`)
  }
}

export async function getTodos(sessionId: string, directory?: string): Promise<OcTodo[]> {
  const url = `${BASE}/session/${sessionId}/todo`
  const res = await fetch(url, {
    headers: withDirectoryHeaders({}, directory),
    signal: fetchSignal(),
  })
  if (!res.ok) throw new Error(`Failed to fetch todos: ${res.status}`)
  const todos = (await res.json()) as OcTodo[]
  if (!isCaseStudyDemoEnabled()) return todos
  return applySessionDemoOverlay(sessionId, [], todos).todos
}

export async function getMessages(sessionId: string, _reason?: string, directory?: string): Promise<OcMessage[]> {
  const url = `${BASE}/session/${sessionId}/message`
  const res = await fetch(url, {
    headers: withDirectoryHeaders({}, directory),
    signal: fetchSignal(),
  })
  if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`)
  const messages = (await res.json()) as OcMessage[]
  if (!isCaseStudyDemoEnabled()) return messages
  return applySessionDemoOverlay(sessionId, messages, []).messages
}

/** One row for the composer dropdown (`ref` is always `providerID/modelID`). */
export interface OcComposerModelOption {
  ref: string
  label: string
  providerId: string
  providerName: string
}

/**
 * Matches OpenCode HTTP API `GET /config/providers` (desktop/TUI use the same provider registry).
 * Response shape: `{ providers: ProviderInfo[], default: Record<string, string> }`.
 */
export async function getComposerModelOptions(directory?: string): Promise<{
  options: OcComposerModelOption[]
  defaultByProvider: Record<string, string>
}> {
  const url = `${BASE}/config/providers`
  const res = await fetch(url, { headers: withDirectoryHeaders({}, directory) })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`GET /config/providers failed: ${res.status} ${bodyText.slice(0, 400)}`)
  }
  let data: unknown
  try {
    data = JSON.parse(bodyText) as unknown
  } catch {
    throw new Error('GET /config/providers returned non-JSON')
  }
  const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const providersRaw = obj.providers
  const providers = Array.isArray(providersRaw) ? providersRaw : []
  const opts: OcComposerModelOption[] = []
  for (const p of providers) {
    if (!p || typeof p !== 'object') continue
    const pr = p as Record<string, unknown>
    const pid = typeof pr.id === 'string' ? pr.id.trim() : ''
    if (!pid) continue
    const providerName = typeof pr.name === 'string' && pr.name.trim() ? pr.name.trim() : pid
    const models = pr.models && typeof pr.models === 'object' ? (pr.models as Record<string, unknown>) : {}
    for (const m of Object.values(models)) {
      if (!m || typeof m !== 'object') continue
      const mr = m as Record<string, unknown>
      const mid = typeof mr.id === 'string' ? mr.id.trim() : ''
      if (!mid) continue
      const name = typeof mr.name === 'string' ? mr.name.trim() : ''
      const costRaw = mr.cost && typeof mr.cost === 'object' ? (mr.cost as Record<string, unknown>) : {}
      const inputCost = Number(costRaw.input)
      const outputCost = Number(costRaw.output)
      const isFree = inputCost === 0 && outputCost === 0
      const freeTag = isFree ? ' · Free' : ''
      const label = name && name !== mid ? `${pid}/${mid} — ${name}${freeTag}` : `${pid}/${mid}${freeTag}`
      opts.push({ ref: `${pid}/${mid}`, label, providerId: pid, providerName })
    }
  }
  opts.sort((a, b) => a.ref.localeCompare(b.ref))
  const defRaw = obj.default
  const defaultByProvider =
    defRaw && typeof defRaw === 'object' && !Array.isArray(defRaw)
      ? { ...(defRaw as Record<string, string>) }
      : {}
  return { options: opts, defaultByProvider }
}

export type UserMessagePartBody =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: { type: string; media_type: string; data: string }
    }

export async function sendMessage(
  sessionId: string,
  text: string,
  directory?: string,
  options?: {
    imageParts?: Array<{ media_type: string; data: string }>
    model?: string
    agent?: string
  },
): Promise<void> {
  const url = `${BASE}/session/${sessionId}/message`
  const imageParts: UserMessagePartBody[] = (options?.imageParts ?? []).map((img) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: img.media_type,
      data: img.data,
    },
  }))
  const parts: UserMessagePartBody[] = [...imageParts, { type: 'text', text }]
  // Always send an explicit model. Priority: caller (dropdown) → VibeTrace default.
  const modelRef =
    (options?.model && options.model.trim()) || resolveVibeTraceDefaultModelRef()
  const modelBody = parseModelRefToBody(modelRef)
  if (!modelBody) {
    throw new Error(`Invalid model ref for sendMessage: ${modelRef}`)
  }
  const agent =
    (options?.agent && options.agent.trim()) ||
    (typeof import.meta.env.VITE_OPENCODE_DEFAULT_AGENT === 'string' && import.meta.env.VITE_OPENCODE_DEFAULT_AGENT.trim()) ||
    undefined
  const reqBody: Record<string, unknown> = { parts, model: modelBody }
  if (agent) reqBody.agent = agent

  const res = await fetch(url, {
    method: 'POST',
    headers: withDirectoryHeaders({ 'Content-Type': 'application/json' }, directory),
    body: JSON.stringify(reqBody),
  })
  const bodyText = await res.text()
  if (!res.ok) throw new Error(`Failed to send message: ${res.status} ${bodyText}`)
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('text/html') || /^\s*</i.test(bodyText)) {
    throw new Error(
      `[OpenCode] POST /message returned HTML instead of JSON — check the path. Expected /session/<sessionId>/message (not /session}/). URL: ${url}`,
    )
  }
}

export async function abortSession(sessionId: string, directory?: string): Promise<void> {
  const url = `${BASE}/session/${sessionId}/abort`
  const res = await fetch(url, {
    method: 'POST',
    headers: withDirectoryHeaders({}, directory),
    signal: fetchSignal(),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`abortSession failed: ${res.status} ${bodyText}`)
  }
}

export async function forkSession(
  sessionId: string,
  options?: { messageID?: string; directory?: string }
): Promise<OcSession> {
  const url = `${BASE}/session/${sessionId}/fork`
  const body = options?.messageID ? { messageID: options.messageID } : {}
  const res = await fetch(url, {
    method: 'POST',
    headers: withDirectoryHeaders({ 'Content-Type': 'application/json' }, options?.directory),
    body: JSON.stringify(body),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`forkSession failed: ${res.status} ${bodyText}`)
  }
  return JSON.parse(bodyText) as OcSession
}

export async function replyToQuestion(
  requestId: string,
  answers: string[][],
  directory?: string,
): Promise<void> {
  const url = `${BASE}/question/${encodeURIComponent(requestId)}/reply`
  const res = await fetch(url, {
    method: 'POST',
    headers: withDirectoryHeaders({ 'Content-Type': 'application/json' }, directory),
    body: JSON.stringify({ answers }),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`replyToQuestion failed: ${res.status} ${bodyText}`)
  }
}

function normalizePendingQuestionList(raw: unknown): OcPendingQuestionItem[] {
  if (Array.isArray(raw)) return raw as OcPendingQuestionItem[]
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    for (const k of ['data', 'items', 'pending', 'result']) {
      const v = o[k]
      if (Array.isArray(v)) return v as OcPendingQuestionItem[]
    }
  }
  return []
}

export async function getPendingQuestions(
  directory?: string,
  options?: { sessionID?: string },
): Promise<OcPendingQuestionItem[]> {
  const buildUrl = (includeSession: boolean) => {
    const params = new URLSearchParams()
    if (directory) params.set('directory', directory)
    if (includeSession && options?.sessionID) params.set('sessionID', options.sessionID)
    const qs = params.toString()
    return qs ? `${BASE}/question?${qs}` : `${BASE}/question`
  }

  const fetchList = async (url: string) => {
    const res = await fetch(url, { headers: withDirectoryHeaders({}, directory) })
    if (!res.ok) return { ok: false as const, status: res.status, text: await res.text() }
    const data = await res.json()
    return { ok: true as const, data }
  }

  let url = buildUrl(true)
  let result = await fetchList(url)
  if (
    !result.ok &&
    options?.sessionID &&
    (result.status === 400 || result.status === 404 || result.status === 422)
  ) {
    url = buildUrl(false)
    result = await fetchList(url)
  }
  if (!result.ok) {
    throw new Error(`getPendingQuestions failed: ${result.status} ${result.text}`)
  }
  return normalizePendingQuestionList(result.data)
}

export async function rejectQuestion(requestId: string, directory?: string): Promise<void> {
  const url = `${BASE}/question/${encodeURIComponent(requestId)}/reject`
  const res = await fetch(url, {
    method: 'POST',
    headers: withDirectoryHeaders({}, directory),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`rejectQuestion failed: ${res.status} ${bodyText}`)
  }
}

// ===== Permission (SSE `permission.asked`, POST `/permission/{id}/reply`) =====

function normalizePendingPermissionList(raw: unknown): OcPendingPermissionItem[] {
  const rows: unknown[] = (() => {
    if (Array.isArray(raw)) return raw
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>
      for (const k of ['data', 'items', 'pending', 'result', 'permissions']) {
        const v = o[k]
        if (Array.isArray(v)) return v
      }
    }
    return []
  })()

  const out: OcPendingPermissionItem[] = []
  for (const row of rows) {
    const normalized = normalizePermissionRequest(row)
    if (normalized) out.push(normalized)
  }
  return out
}

/**
 * OpenCode emits permission asks in several envelopes:
 * - BusEvent: `{ type, properties: PermissionRequest }`
 * - Durable/global: `{ type, data: PermissionRequest, location?, durable? }`
 * - Nested: `{ request: PermissionRequest }`
 * Prefer unwrapping before reading id/session fields so v1 `data` events are not dropped.
 */
function unwrapPermissionEnvelope(
  raw: Record<string, unknown>,
  extras?: { directory?: string; askedAt?: number; sessionID?: string },
): OcPendingPermissionItem | null {
  for (const key of ['data', 'properties', 'request', 'permission'] as const) {
    const nested = raw[key]
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue
    const nestedObj = nested as Record<string, unknown>
    // Skip opaque metadata bags that are not request-shaped
    if (key === 'permission' && typeof nestedObj.id !== 'string' && typeof nestedObj.sessionID !== 'string') {
      continue
    }
    const fromNested = normalizePermissionRequest(nestedObj, extras)
    if (fromNested) return fromNested
  }
  return null
}

/** Normalize PermissionNext / v2 / loose SSE property shapes into OcPendingPermissionRequest */
export function normalizePermissionRequest(
  raw: unknown,
  extras?: { directory?: string; askedAt?: number; sessionID?: string },
): OcPendingPermissionItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>

  const unwrapped = unwrapPermissionEnvelope(o, extras)
  if (unwrapped) return unwrapped

  const idRaw =
    (typeof o.id === 'string' && o.id) ||
    (typeof o.requestID === 'string' && o.requestID) ||
    (typeof o.permissionID === 'string' && o.permissionID) ||
    (typeof o.permissionId === 'string' && o.permissionId) ||
    null
  // Durable envelopes also carry an event id (`evt_…`); only `per…` ids are permission asks.
  const id = idRaw && !idRaw.startsWith('evt_') ? idRaw : null
  const sessionID =
    (typeof o.sessionID === 'string' && o.sessionID) ||
    (typeof o.sessionId === 'string' && o.sessionId) ||
    (typeof extras?.sessionID === 'string' && extras.sessionID) ||
    null
  if (!id || !sessionID) return null

  // Avoid treating bus event envelopes as permission kinds
  const rawPermission =
    (typeof o.permission === 'string' && o.permission) ||
    (typeof o.action === 'string' && o.action) ||
    (typeof o.toolName === 'string' && o.toolName) ||
    null
  const permission = rawPermission || 'unknown'

  const patternsRaw = o.patterns ?? o.resources ?? o.pattern ?? o.paths
  const patterns = Array.isArray(patternsRaw)
    ? patternsRaw.filter((p): p is string => typeof p === 'string')
    : typeof patternsRaw === 'string'
      ? [patternsRaw]
      : []

  const alwaysRaw = o.always ?? o.save
  const always = Array.isArray(alwaysRaw)
    ? alwaysRaw.filter((p): p is string => typeof p === 'string')
    : undefined

  const metadata =
    o.metadata && typeof o.metadata === 'object' && !Array.isArray(o.metadata)
      ? (o.metadata as Record<string, unknown>)
      : undefined

  let tool: { messageID: string; callID: string } | undefined
  const toolRaw = o.tool ?? o.source
  if (toolRaw && typeof toolRaw === 'object') {
    const t = toolRaw as Record<string, unknown>
    const messageID =
      (typeof t.messageID === 'string' && t.messageID) ||
      (typeof t.messageId === 'string' && t.messageId) ||
      ''
    const callID =
      (typeof t.callID === 'string' && t.callID) || (typeof t.callId === 'string' && t.callId) || ''
    if (messageID && callID) tool = { messageID, callID }
  }

  const askedAt =
    extras?.askedAt ??
    (typeof o.askedAt === 'number' && Number.isFinite(o.askedAt) ? o.askedAt : undefined)

  return {
    id,
    sessionID,
    permission,
    patterns,
    metadata,
    always,
    tool,
    directory: extras?.directory ?? (typeof o.directory === 'string' ? o.directory : undefined),
    askedAt,
  }
}

export async function getPendingPermissions(
  directory?: string,
  options?: { sessionID?: string },
): Promise<OcPendingPermissionItem[]> {
  const headers = withDirectoryHeaders({}, directory)

  const candidates: string[] = []
  // Prefer the global pending list — session-scoped `/api/session/.../permission`
  // often returns `{ data: [] }` even while an ask is still live (OpenCode 1.18).
  {
    const params = new URLSearchParams()
    if (directory) params.set('directory', directory)
    if (options?.sessionID) params.set('sessionID', options.sessionID)
    const qs = params.toString()
    candidates.push(qs ? `${BASE}/permission?${qs}` : `${BASE}/permission`)
    candidates.push(qs ? `${BASE}/api/permission/request?${qs}` : `${BASE}/api/permission/request`)
  }
  if (options?.sessionID) {
    const qs = directory ? `?directory=${encodeURIComponent(directory)}` : ''
    candidates.push(`${BASE}/api/session/${encodeURIComponent(options.sessionID)}/permission${qs}`)
    candidates.push(`${BASE}/session/${encodeURIComponent(options.sessionID)}/permission${qs}`)
    // Global list without session query (filter client-side)
    const params = new URLSearchParams()
    if (directory) params.set('directory', directory)
    const gqs = params.toString()
    candidates.push(gqs ? `${BASE}/permission?${gqs}` : `${BASE}/permission`)
    candidates.push(gqs ? `${BASE}/api/permission/request?${gqs}` : `${BASE}/api/permission/request`)
  }

  let lastErr = ''
  const byId = new Map<string, OcPendingPermissionItem>()
  let sawOk = false
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers })
      if (!res.ok) {
        lastErr = `${res.status} ${await res.text()}`
        continue
      }
      sawOk = true
      const data = await res.json()
      let list = normalizePendingPermissionList(data)
      if (options?.sessionID) {
        list = list.filter((p) => p.sessionID === options.sessionID)
      }
      for (const item of list) {
        byId.set(item.id, {
          ...item,
          directory: item.directory ?? directory,
          askedAt: item.askedAt ?? Date.now(),
        })
      }
      // Keep scanning: an earlier endpoint may be empty while a later one has asks.
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  if (!sawOk && byId.size === 0) {
    throw new Error(`getPendingPermissions failed: ${lastErr || 'no endpoint'}`)
  }
  return [...byId.values()]
}

export async function replyToPermission(
  requestId: string,
  reply: OcPermissionReply,
  options?: { sessionID?: string; directory?: string; message?: string },
): Promise<void> {
  const body: { reply: OcPermissionReply; message?: string } = { reply }
  if (options?.message) body.message = options.message
  const headers = withDirectoryHeaders({ 'Content-Type': 'application/json' }, options?.directory)
  const payload = JSON.stringify(body)

  const candidates: string[] = [
    `${BASE}/permission/${encodeURIComponent(requestId)}/reply`,
  ]
  if (options?.sessionID) {
    candidates.unshift(
      `${BASE}/api/session/${encodeURIComponent(options.sessionID)}/permission/${encodeURIComponent(requestId)}/reply`,
    )
    candidates.push(
      `${BASE}/session/${encodeURIComponent(options.sessionID)}/permission/${encodeURIComponent(requestId)}/reply`,
    )
    // Deprecated legacy path still present on some OpenCode builds
    candidates.push(
      `${BASE}/session/${encodeURIComponent(options.sessionID)}/permissions/${encodeURIComponent(requestId)}`,
    )
  }

  let lastErr = ''
  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: payload })
      const bodyText = await res.text()
      if (res.ok) return
      lastErr = `${res.status} ${bodyText}`
      // 404 on path → try next candidate; 404 PermissionNotFoundError should still surface after all tries
      if (res.status !== 404 && res.status !== 405) {
        throw new Error(`replyToPermission failed: ${lastErr}`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('replyToPermission failed:')) throw e
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(`replyToPermission failed: ${lastErr || 'no endpoint'}`)
}

// ===== SSE (fetch stream — supports custom `event:` names) =====

const SSE_RECONNECT_MS = 2500

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function createSseLineDispatcher(
  onDispatch: (eventName: string, data: string) => void
): (line: string) => void {
  let eventName = 'message'
  const dataLines: string[] = []

  return (line: string) => {
    const trimmed = line.replace(/\r$/, '')
    if (trimmed === '') {
      if (dataLines.length > 0) {
        const data = dataLines.join('\n')
        dataLines.length = 0
        const ev = eventName
        eventName = 'message'
        onDispatch(ev, data)
      } else {
        eventName = 'message'
      }
      return
    }
    if (trimmed.startsWith(':')) return
    if (trimmed.startsWith('event:')) {
      eventName = trimmed.slice(6).trim()
      return
    }
    if (trimmed.startsWith('data:')) {
      const rest = trimmed.slice(5)
      dataLines.push(rest.startsWith(' ') ? rest.slice(1) : rest)
    }
  }
}

async function streamGlobalSse(
  url: string,
  signal: AbortSignal,
  onEvent: (event: unknown) => void
): Promise<void> {
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...basicAuthHeader() },
    signal,
  })
  if (!res.ok) {
    throw new Error(`SSE HTTP ${res.status}`)
  }
  const body = res.body
  if (!body) throw new Error('SSE body null')

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  const dispatchLine = createSseLineDispatcher((eventName, dataStr) => {
    try {
      const parsed = JSON.parse(dataStr) as Record<string, unknown>
      // OpenCode usually puts `type` inside JSON; keep SSE `event:` as fallback.
      if (eventName && eventName !== 'message' && parsed && typeof parsed === 'object') {
        onEvent({ ...parsed, __sseEventName: eventName })
      } else {
        onEvent(parsed)
      }
    } catch {
      /* ignore heartbeats / non-JSON frames */
    }
  })

  while (!signal.aborted) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const line of parts) {
      dispatchLine(line)
    }
  }
}

export function subscribeGlobalEvents(
  onEvent: (event: any) => void
): () => void {
  const url = `${BASE}/global/event`
  const ac = new AbortController()

  ;(async function loop() {
    while (!ac.signal.aborted) {
      try {
        await streamGlobalSse(url, ac.signal, onEvent)
      } catch {
        if (ac.signal.aborted) break
      }
      if (ac.signal.aborted) break
      await sleep(SSE_RECONNECT_MS)
    }
  })()

  return () => ac.abort()
}
