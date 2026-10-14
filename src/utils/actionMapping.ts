import type {
  ActionStatus,
  ActionType,
  MappedAction,
  OcMessage,
  OcMessagePart,
  OcSseActionEvent,
  ToolPart,
} from '../types/opencode'
import { isTodoWriteTool, type AssistantSubtask } from './subtaskGrouping'
import { stripHarnessGuidanceForDisplay } from '../config/harnessGuidance'
import { actionKey } from './actionKey'

const SUBAGENT_TOOLS = new Set(['task', 'subtask', 'subagent', 'agent'])

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, '_')
}

function estimateTokensFromStrings(...chunks: (string | undefined)[]): number {
  let n = 0
  for (const c of chunks) {
    if (typeof c === 'string' && c.length > 0) n += c.length
  }
  return Math.max(0, Math.round(n / 4))
}

/** Normalize tool `output` when it is a JSON object into a string for sizing/display */
function toolOutputOrErrorAsString(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function toolStatusToActionStatus(
  part: ToolPart,
  message: OcMessage,
  nowMs: number,
  staleToolCallIDs: Set<string>
): ActionStatus {
  void message
  void nowMs
  const s = part.state?.status
  if (s === 'error') return 'error'
  if (staleToolCallIDs.has(part.callID)) return 'error'
  if (s === 'running' || s === 'pending') {
    return 'running'
  }
  return 'completed'
}

function mapToolToActionType(tool: string): ActionType | null {
  const t = normalizeToolName(tool)
  if (t === 'question') return 'Clarify'
  if (isTodoWriteTool(tool) || t === 'todoread' || t === 'todo_read') return 'Plan'
  if (SUBAGENT_TOOLS.has(t)) return 'Subagent'
  if (['glob', 'grep', 'read'].includes(t)) return 'Read'
  /** OpenCode / plugins may register as `skill_router`, `SkillRouter` (normalized to skillrouter), etc. */
  if (t === 'skill_router' || t === 'skillrouter') return 'SkillRouter'
  if (['write', 'edit', 'multiedit', 'patch'].includes(t)) return 'Write'
  if (t === 'bash' || t === 'shell') return 'Shell'
  if (t === 'websearch' || t === 'web_fetch' || t === 'webfetch') return 'Search'
  if (t === 'skill') return 'Skill'
  return null
}

function durationForReasoning(part: { time?: { start?: number; end?: number }; text?: string }): number {
  const { start, end } = part.time ?? {}
  if (typeof start === 'number' && typeof end === 'number' && end >= start) {
    if (end > start) return Math.max(10, end - start)
    /** Common: streaming start/end are indistinguishable instant points; must not fall back to token*40 (would inflate Think to ~30s fake duration) */
    return 10
  }
  return Math.min(30_000, Math.max(0, estimateTokensFromStrings(part.text) * 40))
}

function durationForTool(part: ToolPart, message: OcMessage, nowMs: number): number {
  const st = part.state?.status
  if (st === 'running' || st === 'pending') {
    const start = part.state?.time?.start ?? message.info.time?.created
    if (typeof start === 'number' && Number.isFinite(start)) {
      return Math.max(0, nowMs - start)
    }
    return 0
  }
  const start = part.state?.time?.start
  const end = part.state?.time?.end
  if (typeof start === 'number' && typeof end === 'number' && end > start) {
    return Math.max(10, end - start)
  }
  const created = message.info.time?.created ?? 0
  const completed = message.info.time?.completed
  if (typeof completed === 'number' && completed > created) {
    return Math.max(10, completed - created)
  }
  const out = toolOutputOrErrorAsString(part.state?.output)
  const inp = part.state?.input
  const inpStr = inp ? JSON.stringify(inp) : ''
  return Math.max(10, 80 + estimateTokensFromStrings(out, inpStr) * 30)
}

/** Tool wall-clock interval for parallel overlap detection (same semantics as duration) */
function toolWallClockWindow(
  part: ToolPart,
  message: OcMessage,
  nowMs: number
): { startMs: number; endMs: number } | undefined {
  const st = part.state?.status
  let start = part.state?.time?.start
  if (typeof start !== 'number' || !Number.isFinite(start)) {
    const created = message.info.time?.created
    if (typeof created !== 'number' || !Number.isFinite(created)) return undefined
    start = created
  }
  const end = part.state?.time?.end
  if (typeof end === 'number' && end >= start) return { startMs: start, endMs: end }
  if (st === 'running' || st === 'pending') return { startMs: start, endMs: nowMs }
  return { startMs: start, endMs: start + 1 }
}

function parseToolError(errorRaw?: string): { name?: string; message?: string } {
  const text = (errorRaw ?? '').trim()
  if (!text) return {}
  const firstColon = text.indexOf(':')
  if (firstColon <= 0) return { name: text, message: text }
  const name = text.slice(0, firstColon).trim()
  const message = text.slice(firstColon + 1).trim()
  return {
    name: name || text,
    message: message || text,
  }
}

function pickFirstString(values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

function parseJsonRecord(raw?: string): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === 'object') return v as Record<string, unknown>
  } catch {
    /* ignore */
  }
  return null
}

function outputRecordFromToolState(output: unknown): Record<string, unknown> | null {
  if (output == null) return null
  if (typeof output === 'object' && !Array.isArray(output)) return output as Record<string, unknown>
  if (typeof output === 'string') return parseJsonRecord(output)
  return null
}

/**
 * Extract child session id for task/subagent uniformly.
 * Compatible with fields that may appear in running/completed phases:
 * - state.metadata.sessionId / sessionID / task_id
 * - task_id: xxx in state.output text
 * - metadata.sessionId / sessionId in state.output JSON
 */
export function extractChildSessionIdFromToolPart(part: ToolPart): string | undefined {
  const input = part.state?.input ?? {}
  const meta = (part.state?.metadata ?? {}) as Record<string, unknown>
  const outStr = toolOutputOrErrorAsString(part.state?.output)
  const outJson = outputRecordFromToolState(part.state?.output)
  const outMeta =
    outJson && typeof outJson.metadata === 'object' && outJson.metadata
      ? (outJson.metadata as Record<string, unknown>)
      : {}

  const direct = pickFirstString([
    meta.sessionId,
    meta.sessionID,
    meta.task_id,
    outMeta.sessionId,
    outMeta.sessionID,
    outMeta.task_id,
    outJson?.sessionId,
    outJson?.sessionID,
    outJson?.task_id,
    input.sessionId,
    input.sessionID,
  ])
  if (direct) return direct

  const m = outStr.match(/task_id:\s*([A-Za-z0-9_-]+)/i)
  if (m?.[1]) return m[1]
  return undefined
}

function durationForText(text: string): number {
  return Math.max(50, 50 + text.length * 15)
}

function userMessageDisplayText(message: OcMessage): string {
  const partText = message.parts
    .filter((part): part is Extract<OcMessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n\n')
  const raw = partText || message.info.content || ''
  return stripHarnessGuidanceForDisplay(raw).trim()
}

export function isSubagentToolName(tool: string): boolean {
  const t = normalizeToolName(tool)
  return SUBAGENT_TOOLS.has(t)
}

/**
 * Distinguish end-user input from the synthetic user turn seeded when a task/subagent child session starts.
 * Child-session rows are tagged in `buildChildSessionBranchActions` (`source: 'child-session'`) even though
 * the underlying OpenCode message still has `role: 'user'`.
 */
export function isSubagentSeededUserRequest(act: MappedAction): boolean {
  return act.actionType === 'UserRequest' && act.source === 'child-session'
}

/**
 * Each agent process occupies two horizontal tracks:
 * - layer 0: kernel (think, reply, todowrite/Plan, compaction, etc. — no external resources)
 * - layer 1: external resources (disk read, network, shell, task parent rect, question, etc.)
 *
 * Different session = different process: stacked vertically, distinguished by `processBand` (0=main session, 1=first child session, …).
 * `row = processBand * ROWS_PER_PROCESS + layer`
 */
export const ROWS_PER_PROCESS = 2

function localLayerForActionType(actionType: ActionType): 0 | 1 {
  if (
    actionType === 'UserRequest' ||
    actionType === 'Think' ||
    actionType === 'Response' ||
    actionType === 'Compaction' ||
    actionType === 'Plan'
  ) {
    return 0
  }
  return 1
}

function actionRowForBand(processBand: number, actionType: ActionType): number {
  return processBand * ROWS_PER_PROCESS + localLayerForActionType(actionType)
}

/**
 * Map a single session's messages to actions.
 * Key constraint: one session always uses two rows (LLM inner + external resources), never retargeted for task nesting.
 * `bandStart`: process-band index for this session in the global vertical layout (0=parent session, 1..N=child sessions).
 */

export type TaskChildDescriptor = {
  callID: string
  childSessionID: string
  /** Owning assistant message id (same boundary as parallel detection by message) */
  messageId: string
  /** Aligned with that task part's sortTime in parent `buildMappedActionsFromMessages` */
  anchorSortTime: number
  description?: string
}

/**
 * Collect task/subagent tools from parent session messages that already resolve a child session (dedupe callID+child).
 */
export function collectTaskChildDescriptors(messages: OcMessage[]): TaskChildDescriptor[] {
  const out: TaskChildDescriptor[] = []
  const seen = new Set<string>()
  messages.forEach((message) => {
    if (message.info.role !== 'assistant') return
    const baseTime = message.info.time?.created ?? 0
    message.parts.forEach((part, partIndex) => {
      if (part.type !== 'tool' || !isSubagentToolName(part.tool)) return
      const sid = extractChildSessionIdFromToolPart(part)
      if (!sid) return
      const key = `${part.callID}__${sid}`
      if (seen.has(key)) return
      seen.add(key)
      const input = part.state?.input
      const description =
        input && typeof input === 'object' && typeof (input as { description?: unknown }).description === 'string'
          ? String((input as { description: string }).description)
          : undefined
      out.push({
        callID: part.callID,
        childSessionID: sid,
        messageId: message.info.id,
        anchorSortTime: baseTime + partIndex * 0.001,
        description,
      })
    })
  })
  return out
}

/**
 * Map GET /message results for a child session onto an independent process band (`sessionBandIndex`: 1st child usually 1, 2nd 2, …).
 */
export function buildChildSessionBranchActions(
  childMessages: OcMessage[],
  opts: {
    branchChildSessionID: string
    parentTaskCallID: string
    anchorSortTime: number
    /** Process-band index for vertical stacking (distinct from main session 0) */
    sessionBandIndex: number
    nowMs?: number
  },
): (MappedAction & { row: number })[] {
  const inner = buildMappedActionsFromMessages(childMessages, {
    bandStart: opts.sessionBandIndex,
    nowMs: opts.nowMs,
  })
  if (inner.length === 0) return []
  const minT = Math.min(...inner.map((a) => a.sortTime))
  return inner.map((a, i) => ({
    ...a,
    sortTime: opts.anchorSortTime + 0.002 + (a.sortTime - minT) + i * 1e-9,
    source: 'child-session' as const,
    branchChildSessionID: opts.branchChildSessionID,
    parentTaskCallID: opts.parentTaskCallID,
  }))
}

export function buildMappedActionsFromMessages(
  messages: OcMessage[],
  options?: { bandStart?: number; nowMs?: number },
): (MappedAction & { row: number })[] {
  const out: (MappedAction & { row: number })[] = []
  const processBand = options?.bandStart ?? 0
  const nowMs = options?.nowMs ?? Date.now()
  const staleToolCallIDs = collectStaleToolCallIDs(messages)

  /** Each output `messageIndex` refers to the **`messages`** array passed here (`segmentMessages` in subtasks), not necessarily the global session list — correlate UI with `message.info.id`. */
  messages.forEach((message, messageIndex) => {
    const baseTime = message.info.time?.created ?? 0
    const mid = message.info.id

    if (message.info.role === 'user') {
      const text = userMessageDisplayText(message)
      const firstTextPart = message.parts.find((part) => part.type === 'text')
      out.push({
        actionType: 'UserRequest',
        status: 'completed',
        durationMs: Math.max(10, durationForText(text)),
        tokenEstimate: estimateTokensFromStrings(text),
        sortTime: baseTime,
        source: 'part',
        sessionID: message.info.sessionID,
        messageID: mid,
        partIndex: firstTextPart ? message.parts.indexOf(firstTextPart) : 0,
        messageIndex,
        partId: firstTextPart?.id,
        detail: text || '(empty)',
        row: actionRowForBand(processBand, 'UserRequest'),
      })
      return
    }

    if (message.info.role !== 'assistant') return

    message.parts.forEach((part, partIndex) => {
      const sortTime = baseTime + partIndex * 0.001
      const mapped = partToMappedAction(
        part,
        message,
        messageIndex,
        partIndex,
        sortTime,
        mid,
        nowMs,
        staleToolCallIDs
      )
      if (!mapped) return

      const row = actionRowForBand(processBand, mapped.actionType)
      out.push({ ...mapped, row })
    })
  })

  return out
}

function partToMappedAction(
  part: OcMessagePart,
  message: OcMessage,
  messageIndex: number,
  partIndex: number,
  sortTime: number,
  messageID: string,
  nowMs: number,
  staleToolCallIDs: Set<string>
): MappedAction | null {
  switch (part.type) {
    case 'reasoning': {
      const text = part.text ?? ''
      return {
        actionType: 'Think',
        status: 'completed',
        durationMs: durationForReasoning(part),
        tokenEstimate: estimateTokensFromStrings(text),
        sortTime,
        source: 'part',
        sessionID: message.info.sessionID,
        messageID,
        partIndex,
        messageIndex,
        partId: part.id,
        detail: text.slice(0, 80),
      }
    }
    case 'text': {
      const text = part.text ?? ''
      return {
        actionType: 'Response',
        status: 'completed',
        durationMs: durationForText(text),
        tokenEstimate: estimateTokensFromStrings(text),
        sortTime,
        source: 'part',
        sessionID: message.info.sessionID,
        messageID,
        partIndex,
        messageIndex,
        partId: part.id,
        detail: text.slice(0, 80),
      }
    }
    case 'compaction': {
      const cp = part as { text?: string; auto?: boolean; overflow?: boolean }
      const detailBits = [
        cp.auto === true ? 'auto' : cp.auto === false ? 'manual' : null,
        cp.overflow ? 'overflow' : null,
        cp.text?.trim() ? cp.text.trim().slice(0, 80) : null,
      ].filter(Boolean)
      return {
        actionType: 'Compaction',
        status: 'completed',
        durationMs: 400,
        tokenEstimate: estimateTokensFromStrings(cp.text),
        sortTime,
        source: 'part',
        sessionID: message.info.sessionID,
        messageID,
        partIndex,
        messageIndex,
        partId: part.id,
        detail: detailBits.length > 0 ? detailBits.join(' · ') : 'compaction',
      }
    }
    case 'tool': {
      const mappedType = mapToolToActionType(part.tool)
      if (!mappedType) return null
      const inp = part.state?.input
      const inpStr = inp ? JSON.stringify(inp) : ''
      const outStr = toolOutputOrErrorAsString(part.state?.output)
      const errStr = toolOutputOrErrorAsString(part.state?.error)
      const parsedErr = parseToolError(errStr)
      const childSessionID = isSubagentToolName(part.tool)
        ? extractChildSessionIdFromToolPart(part)
        : undefined
      const parallelKey = part.callID || childSessionID
      const toolWindow = toolWallClockWindow(part, message, nowMs)
      const status = toolStatusToActionStatus(part, message, nowMs, staleToolCallIDs)
      return {
        actionType: mappedType,
        status,
        durationMs: durationForTool(part, message, nowMs),
        tokenEstimate: estimateTokensFromStrings(inpStr, outStr, errStr),
        sortTime,
        source: 'part',
        sessionID: message.info.sessionID,
        messageID,
        callID: part.callID,
        childSessionID,
        parallelKey,
        toolWindow,
        partIndex,
        messageIndex,
        partId: part.id,
        detail: part.tool,
        errorName: parsedErr.name,
        errorMessage:
          parsedErr.message ??
          (status === 'error'
            ? 'Tool did not finalize before next assistant turn.'
            : undefined),
      }
    }
    default:
      return null
  }
}

/**
 * `data-transcript-action-key` on bubbles — must match `actionKey(act)` embedded in flows for `bandStart` (main = 0).
 * `messageIndex` inside `MappedAction` is unused by `actionKey()`.
 */
export function transcriptAnchorKeyForPart(
  message: OcMessage,
  part: OcMessagePart,
  partIndex: number,
  nowMs: number,
  staleToolCallIDs: Set<string>,
  bandStart = 0,
): string | null {
  if (message.info.role !== 'assistant') return null
  const baseTime = message.info.time?.created ?? 0
  const sortTime = baseTime + partIndex * 0.001
  const mapped = partToMappedAction(
    part,
    message,
    0,
    partIndex,
    sortTime,
    message.info.id,
    nowMs,
    staleToolCallIDs,
  )
  if (!mapped) return null
  const row = actionRowForBand(bandStart, mapped.actionType)
  return actionKey({ ...mapped, row })
}

/**
 * Stable `actionKey` for the first flow block in a subtask card’s parent segment (same ordering as `SubtaskCard`’s
 * `buildMappedActionsFromMessages(segmentMessages)` before child-session merge). Skips `UserRequest` bubbles (user
 * column has no `data-transcript-action-key` yet).
 */
export function firstFlowAnchorKeyForSubtaskSegment(
  subtask: AssistantSubtask,
  messages: OcMessage[],
  nowMs: number,
): string | null {
  const indices = [...(subtask.userMessageIndices ?? []), ...subtask.assistantMessageIndices].sort(
    (a, b) => a - b,
  )
  const segmentMessages = indices
    .map((i) => messages[i])
    .filter((m): m is OcMessage => m != null)
  if (segmentMessages.length === 0) return null
  const actions = buildMappedActionsFromMessages(segmentMessages, { nowMs })
  if (actions.length === 0) return null
  const sorted = [...actions].sort((a, b) => a.sortTime - b.sortTime)
  const firstVisual = sorted.find((a) => a.actionType !== 'UserRequest') ?? sorted[0]
  if (!firstVisual) return null
  return actionKey(firstVisual)
}

/** Mark stale tools from message sequence: if a tool is still pending/running but a later assistant message has started, treat the call as never returning a result. */
export function collectStaleToolCallIDs(messages: OcMessage[]): Set<string> {
  const stale = new Set<string>()
  const assistantIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.info.role === 'assistant') assistantIndices.push(i)
  }
  if (assistantIndices.length <= 1) return stale

  for (let k = 0; k < assistantIndices.length - 1; k++) {
    const idx = assistantIndices[k]!
    const msg = messages[idx]!
    for (const p of msg.parts) {
      if (p.type !== 'tool') continue
      const s = p.state?.status
      if (s === 'running' || s === 'pending') {
        stale.add(p.callID)
      }
    }
  }
  return stale
}

export function mapSseToMappedActions(events: OcSseActionEvent[]): (MappedAction & { row: number })[] {
  const out: (MappedAction & { row: number })[] = []
  for (const ev of events) {
    if (ev.type === 'permission.asked') {
      const p = ev.permission
      const detail = p
        ? [
            p.permission,
            p.patterns.length ? p.patterns.slice(0, 3).join(', ') : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : safeDetail(ev.raw)
      out.push({
        actionType: 'Permission',
        status: 'pending',
        durationMs: Math.max(0, Date.now() - ev.time),
        tokenEstimate: 0,
        sortTime: ev.time,
        source: 'sse-permission',
        detail: detail.slice(0, 160),
        messageID: p?.tool?.messageID,
        callID: p?.tool?.callID,
        row: actionRowForBand(0, 'Permission'),
      })
    } else if (
      ev.type === 'session.compacted' ||
      ev.type === 'session.next.compaction.started' ||
      ev.type === 'session.next.compaction.ended' ||
      ev.type === 'session.next.compaction.delta'
    ) {
      const status = ev.compaction?.status ?? (ev.type.includes('started') || ev.type.includes('delta') ? 'running' : 'completed')
      out.push({
        actionType: 'Compaction',
        status,
        durationMs: status === 'running' ? Math.max(0, Date.now() - ev.time) : 600,
        tokenEstimate: 0,
        sortTime: ev.time,
        source: 'sse-session',
        detail: ev.compaction?.detail ?? ev.type,
        sessionID: ev.sessionID,
        row: actionRowForBand(0, 'Compaction'),
      })
    }
  }
  return out
}

/** Build a live Permission MappedAction from a pending request (for action-flow merge). */
export function mappedActionFromPendingPermission(
  p: { permission: string; patterns: string[]; askedAt?: number; tool?: { messageID: string; callID: string }; id?: string },
  nowMs = Date.now(),
): MappedAction & { row: number } {
  const askedAt = p.askedAt ?? nowMs
  const detail = [p.permission, p.patterns.length ? p.patterns.slice(0, 3).join(', ') : null]
    .filter(Boolean)
    .join(' · ')
  return {
    actionType: 'Permission',
    status: 'pending',
    durationMs: Math.max(0, nowMs - askedAt),
    tokenEstimate: 0,
    sortTime: askedAt,
    source: 'sse-permission',
    detail: detail.slice(0, 160),
    messageID: p.tool?.messageID,
    callID: p.tool?.callID ?? (p.id ? `permission:${p.id}` : undefined),
    partId: p.id ? `permission:${p.id}` : undefined,
    row: actionRowForBand(0, 'Permission'),
  }
}

/** Permission trail node — stays on the flow after the user replies. */
export function mappedActionFromPermissionTrace(
  t: {
    id: string
    permission: string
    patterns: string[]
    askedAt: number
    repliedAt?: number
    reply?: string
    status: 'pending' | 'running' | 'completed' | 'error'
    tool?: { messageID: string; callID: string }
    sessionID?: string
  },
  nowMs = Date.now(),
): MappedAction & { row: number } {
  const end = t.repliedAt ?? (t.status === 'pending' ? nowMs : t.askedAt)
  const replyBit =
    t.reply === 'once'
      ? 'allow once'
      : t.reply === 'always'
        ? 'always'
        : t.reply === 'reject'
          ? 'reject'
          : t.status === 'pending'
            ? 'asking'
            : null
  const detail = [t.permission, t.patterns.length ? t.patterns.slice(0, 3).join(', ') : null, replyBit]
    .filter(Boolean)
    .join(' · ')
  return {
    actionType: 'Permission',
    status: t.status,
    durationMs: Math.max(0, end - t.askedAt),
    tokenEstimate: 0,
    sortTime: t.askedAt,
    source: 'sse-permission',
    detail: detail.slice(0, 160),
    sessionID: t.sessionID,
    messageID: t.tool?.messageID,
    callID: t.tool?.callID ?? `permission:${t.id}`,
    partId: `permission:${t.id}`,
    row: actionRowForBand(0, 'Permission'),
  }
}

/** Build a live Compaction MappedAction from an SSE compaction marker. */
export function mappedActionFromCompactionEvent(
  ev: { time: number; status: 'running' | 'completed'; detail?: string; sessionID?: string },
  nowMs = Date.now(),
): MappedAction & { row: number } {
  return {
    actionType: 'Compaction',
    status: ev.status,
    durationMs: ev.status === 'running' ? Math.max(0, nowMs - ev.time) : 600,
    tokenEstimate: 0,
    sortTime: ev.time,
    source: 'sse-session',
    detail: (ev.detail ?? 'session.compacted').slice(0, 160),
    sessionID: ev.sessionID,
    row: actionRowForBand(0, 'Compaction'),
  }
}

function safeDetail(raw: unknown): string {
  try {
    return JSON.stringify(raw).slice(0, 160)
  } catch {
    return ''
  }
}

/** Merge part and SSE actions, sorted by time; SSE items keep row=1 (no subtask context) */
export function mergeActions(
  fromMessages: (MappedAction & { row: number })[],
  fromSse: (MappedAction & { row: number })[]
): (MappedAction & { row: number })[] {
  return [...fromMessages, ...fromSse].sort((a, b) => a.sortTime - b.sortTime)
}

/** When call_ids differ only in the trailing suffix, strip the last `_suffix` segment as the stem */
export function callIdStem(callID: string): string {
  const i = callID.lastIndexOf('_')
  return i >= 0 ? callID.slice(0, i) : callID
}

function windowsOverlap(
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number }
): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs
}

export type ParallelCallInfo = { parallelGroupId: string; parallelLaneIndex: number }

/**
 * EXPERIMENTAL (2026-06-29): relaxed parallel detection — bucket by assistant `messageId` only;
 * no `callIdStem` gate. Overlapping wall-clock intervals within the same message → parallel.
 * May revert; see `docs/deferred-backlog.md` §4.
 *
 * Returns callID → group id + lane (0..n-1 by ascending start).
 */
export function detectParallelCallMapping(messages: OcMessage[], nowMs: number): Map<string, ParallelCallInfo> {
  const out = new Map<string, ParallelCallInfo>()
  type ToolMeta = {
    messageId: string
    callID: string
    window: { startMs: number; endMs: number }
    startMs: number
  }
  const tools: ToolMeta[] = []
  for (const message of messages) {
    if (message.info.role !== 'assistant') continue
    const mid = message.info.id
    for (const part of message.parts) {
      if (part.type !== 'tool') continue
      const tw = toolWallClockWindow(part, message, nowMs)
      if (!tw) continue
      tools.push({
        messageId: mid,
        callID: part.callID,
        window: tw,
        startMs: tw.startMs,
      })
    }
  }
  const byKey = new Map<string, ToolMeta[]>()
  for (const t of tools) {
    let arr = byKey.get(t.messageId)
    if (!arr) {
      arr = []
      byKey.set(t.messageId, arr)
    }
    arr.push(t)
  }
  for (const arr of byKey.values()) {
    if (arr.length < 2) continue
    const n = arr.length
    const uf = new Int32Array(n)
    for (let i = 0; i < n; i++) uf[i] = i
    const find = (i: number): number => {
      let x = i
      while (uf[x] !== x) x = uf[x]!
      return x
    }
    const union = (i: number, j: number) => {
      const ri = find(i)
      const rj = find(j)
      if (ri !== rj) uf[ri] = rj
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (windowsOverlap(arr[i]!.window, arr[j]!.window)) union(i, j)
      }
    }
    const comps = new Map<number, ToolMeta[]>()
    for (let i = 0; i < n; i++) {
      const r = find(i)
      let list = comps.get(r)
      if (!list) {
        list = []
        comps.set(r, list)
      }
      list.push(arr[i]!)
    }
    for (const list of comps.values()) {
      if (list.length < 2) continue
      const sorted = [...list].sort((a, b) => a.startMs - b.startMs)
      const messageId = sorted[0]!.messageId
      const minCall = [...sorted.map((m) => m.callID)].sort()[0]!
      const parallelGroupId = `pg-${messageId}-${minCall}`
      sorted.forEach((m, lane) => {
        out.set(m.callID, { parallelGroupId, parallelLaneIndex: lane })
      })
    }
  }
  return out
}

/** Write parallel group id / lane onto mapped actions (child-session actions inherit via parentTaskCallID) */
export function applyParallelLayoutFromCalls(
  actions: (MappedAction & { row: number })[],
  parallelByCallId: Map<string, ParallelCallInfo>
): (MappedAction & { row: number })[] {
  return actions.map((a) => {
    const direct = a.callID ? parallelByCallId.get(a.callID) : undefined
    const inherited = a.parentTaskCallID ? parallelByCallId.get(a.parentTaskCallID) : undefined
    const p = direct ?? inherited
    if (!p) return a
    return { ...a, parallelGroupId: p.parallelGroupId, parallelLaneIndex: p.parallelLaneIndex }
  })
}

/**
 * Each child session gets its own process-band index (for `row` / kernel+tool dual layer);
 * parallel sub-agents each get an SVG swimlane (`session:task:<callID>`), stacked by parallelLaneIndex, not sharing a band.
 */
export function buildChildSessionBandMap(
  descriptors: TaskChildDescriptor[],
  parallelByCallId: Map<string, ParallelCallInfo>
): Map<string, number> {
  const ordered = [...descriptors].sort((a, b) => {
    const pa = parallelByCallId.get(a.callID)
    const pb = parallelByCallId.get(b.callID)
    const ga = pa?.parallelGroupId ?? ''
    const gb = pb?.parallelGroupId ?? ''
    if (ga !== gb) return ga.localeCompare(gb)
    const la = pa?.parallelLaneIndex ?? 0
    const lb = pb?.parallelLaneIndex ?? 0
    if (la !== lb) return la - lb
    return a.anchorSortTime - b.anchorSortTime
  })
  const m = new Map<string, number>()
  let nextBand = 1
  for (const d of ordered) {
    if (!m.has(d.childSessionID)) {
      m.set(d.childSessionID, nextBand++)
    }
  }
  return m
}
