import type {
  OcSession,
  OcTodo,
  OcMessage,
  OcPendingQuestionItem,
} from '../types/opencode'

/**
 * OpenCode HTTP base URL (must match the address printed by `opencode serve` in your terminal).
 * - Easiest fix: add `.env.local` at the repo root with `VITE_OPENCODE_BASE=http://127.0.0.1:61830` (swap port), then restart `npm run dev`
 * - Or change the default URL returned below
 */
function resolveOpencodeBase(): string {
  const raw = import.meta.env.VITE_OPENCODE_BASE
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim().replace(/\/$/, '')
  }
  return 'http://127.0.0.1:4096'
}

const BASE = resolveOpencodeBase()

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

export async function getSessions(options?: { directory?: string }): Promise<OcSession[]> {
  const url = `${BASE}/session`
  const res = await fetch(url, { headers: withDirectoryHeaders({}, options?.directory) })
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`)
  return res.json()
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
  const res = await fetch(url, { headers: withDirectoryHeaders({}, directory) })
  if (!res.ok) throw new Error(`Failed to fetch todos: ${res.status}`)
  return res.json()
}

export async function getMessages(sessionId: string, _reason?: string, directory?: string): Promise<OcMessage[]> {
  const url = `${BASE}/session/${sessionId}/message`
  const res = await fetch(url, { headers: withDirectoryHeaders({}, directory) })
  if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`)
  return res.json()
}

/** One row for the composer dropdown (`ref` is always `providerID/modelID`). */
export interface OcComposerModelOption {
  ref: string
  label: string
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
    const models = pr.models && typeof pr.models === 'object' ? (pr.models as Record<string, unknown>) : {}
    for (const m of Object.values(models)) {
      if (!m || typeof m !== 'object') continue
      const mr = m as Record<string, unknown>
      const mid = typeof mr.id === 'string' ? mr.id.trim() : ''
      if (!mid) continue
      const name = typeof mr.name === 'string' ? mr.name.trim() : ''
      const label = name && name !== mid ? `${pid}/${mid} — ${name}` : `${pid}/${mid}`
      opts.push({ ref: `${pid}/${mid}`, label })
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
  const modelRef =
    (options?.model && options.model.trim()) ||
    (typeof import.meta.env.VITE_OPENCODE_DEFAULT_MODEL === 'string' && import.meta.env.VITE_OPENCODE_DEFAULT_MODEL.trim()) ||
    undefined
  const modelBody = modelRef ? parseModelRefToBody(modelRef) : undefined
  const agent =
    (options?.agent && options.agent.trim()) ||
    (typeof import.meta.env.VITE_OPENCODE_DEFAULT_AGENT === 'string' && import.meta.env.VITE_OPENCODE_DEFAULT_AGENT.trim()) ||
    undefined
  const reqBody: Record<string, unknown> = { parts }
  if (modelBody) reqBody.model = modelBody
  if (agent) reqBody.agent = agent

  const explicitModel = options?.model?.trim()
  const resolution =
    modelBody && explicitModel
      ? 'composer/options.model'
      : modelBody
        ? 'VITE_OPENCODE_DEFAULT_MODEL'
        : 'server default (omit JSON.model)'
  console.info('[OpenScope][OpenCode] sendMessage', {
    sessionId,
    directory: directory ?? null,
    model: modelBody ? `${modelBody.providerID}/${modelBody.modelID}` : null,
    resolution,
  })

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

  const dispatchLine = createSseLineDispatcher((_eventName, dataStr) => {
    try {
      const parsed = JSON.parse(dataStr) as Record<string, unknown>
      onEvent(parsed)
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
