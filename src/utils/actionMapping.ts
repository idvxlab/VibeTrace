import type {
  ActionStatus,
  ActionType,
  MappedAction,
  OcMessage,
  OcMessagePart,
  OcSseActionEvent,
  ToolPart,
} from '../types/opencode'
import { isTodoWriteTool } from './subtaskGrouping'

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
  if (['write', 'edit', 'multiedit', 'patch'].includes(t)) return 'Write'
  if (t === 'bash' || t === 'shell') return 'Shell'
  if (t === 'websearch' || t === 'web_fetch' || t === 'webfetch') return 'Search'
  if (t === 'skill') return 'Skill'
  return null
}

function durationForReasoning(part: { time?: { start?: number; end?: number }; text?: string }): number {
  const { start, end } = part.time ?? {}
  if (typeof start === 'number' && typeof end === 'number' && end > start) {
    return Math.max(10, end - start)
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
    return Math.min(120_000, Math.max(10, end - start))
  }
  const created = message.info.time?.created ?? 0
  const completed = message.info.time?.completed
  if (typeof completed === 'number' && completed > created) {
    return Math.min(120_000, completed - created)
  }
  const out = part.state?.output ?? ''
  const inp = part.state?.input
  const inpStr = inp ? JSON.stringify(inp) : ''
  return Math.min(60_000, 80 + estimateTokensFromStrings(out, inpStr) * 30)
}

/** 工具 wall-clock 区间，用于并行重叠判定（与 duration 语义一致） */
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

/**
 * 统一提取 task/subagent 的子会话 id。
 * 兼容 running/completed 两阶段里可能出现的字段：
 * - state.metadata.sessionId / sessionID / task_id
 * - state.output 文本中的 task_id: xxx
 * - state.output JSON 的 metadata.sessionId / sessionId
 */
export function extractChildSessionIdFromToolPart(part: ToolPart): string | undefined {
  const input = part.state?.input ?? {}
  const meta = (part.state?.metadata ?? {}) as Record<string, unknown>
  const out = part.state?.output ?? ''
  const outJson = parseJsonRecord(out)
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

  const m = out.match(/task_id:\s*([A-Za-z0-9_-]+)/i)
  if (m?.[1]) return m[1]
  return undefined
}

function durationForText(text: string): number {
  return Math.min(120_000, 50 + text.length * 15)
}

export function isSubagentToolName(tool: string): boolean {
  const t = normalizeToolName(tool)
  return SUBAGENT_TOOLS.has(t)
}

/**
 * 每个 agent 进程占两条横轨：
 * - layer 0：kernel（思考、回复、todowrite/Plan、压缩等，不碰外部资源）
 * - layer 1：外部资源（读盘、网络、shell、task 父级 rect、question 等）
 *
 * 不同 session = 不同进程：在垂直方向向下堆叠，用 `processBand` 区分（0=主会话，1=第一个子会话…）。
 * `row = processBand * ROWS_PER_PROCESS + layer`
 */
export const ROWS_PER_PROCESS = 2

function localLayerForActionType(actionType: ActionType): 0 | 1 {
  if (
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
 * 将单个 session 的消息映射为动作。
 * 关键约束：一个 session 固定占两行（LLM 内 + 外部资源），不因 task 嵌套临时改带。
 * `bandStart`：该 session 在全局垂直布局中的进程带索引（0=父会话，1..N=子会话）。
 */

export type TaskChildDescriptor = {
  callID: string
  childSessionID: string
  /** 所属 assistant 消息 id（与并行判定 message 边界一致） */
  messageId: string
  /** 与父段 `buildMappedActionsFromMessages` 中该 task part 的 sortTime 对齐 */
  anchorSortTime: number
  description?: string
}

/**
 * 从父会话消息中收集「已能解析出子 session」的 task/subagent 工具（去重 callID+child）。
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
 * 将子会话 GET /message 的结果映射到独立进程带（`sessionBandIndex`：第 1 个子会话通常为 1，第 2 个为 2…）。
 */
export function buildChildSessionBranchActions(
  childMessages: OcMessage[],
  opts: {
    branchChildSessionID: string
    parentTaskCallID: string
    anchorSortTime: number
    /** 该子会话在垂直堆叠中的进程带序号（与主会话 0 区分） */
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

  messages.forEach((message, messageIndex) => {
    if (message.info.role !== 'assistant') return
    const baseTime = message.info.time?.created ?? 0
    const mid = message.info.id

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
    case 'compaction':
      return {
        actionType: 'Compaction',
        status: 'completed',
        durationMs: 400,
        tokenEstimate: estimateTokensFromStrings(part.text),
        sortTime,
        source: 'part',
        sessionID: message.info.sessionID,
        messageID,
        partIndex,
        messageIndex,
        partId: part.id,
      }
    case 'tool': {
      const mappedType = mapToolToActionType(part.tool)
      if (!mappedType) return null
      const inp = part.state?.input
      const inpStr = inp ? JSON.stringify(inp) : ''
      const outStr = part.state?.output ?? ''
      const errStr = part.state?.error ?? ''
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

/** 基于消息序列判定失效工具：若某 tool 仍 pending/running，但后续 assistant 消息已开始，则视为该 call 不会再回流结果。 */
function collectStaleToolCallIDs(messages: OcMessage[]): Set<string> {
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
      out.push({
        actionType: 'Permission',
        status: 'pending',
        durationMs: 0,
        tokenEstimate: 0,
        sortTime: ev.time,
        source: 'sse-permission',
        detail: safeDetail(ev.raw),
        row: actionRowForBand(0, 'Permission'),
      })
    } else if (ev.type === 'session.compacted') {
      out.push({
        actionType: 'Compaction',
        status: 'completed',
        durationMs: 600,
        tokenEstimate: 0,
        sortTime: ev.time,
        source: 'sse-session',
        detail: 'session.compacted',
        row: actionRowForBand(0, 'Compaction'),
      })
    }
  }
  return out
}

function safeDetail(raw: unknown): string {
  try {
    return JSON.stringify(raw).slice(0, 160)
  } catch {
    return ''
  }
}

/** 合并 part 与 SSE 动作，按时间排序；SSE 项保持 row=1（无子任务上下文） */
export function mergeActions(
  fromMessages: (MappedAction & { row: number })[],
  fromSse: (MappedAction & { row: number })[]
): (MappedAction & { row: number })[] {
  return [...fromMessages, ...fromSse].sort((a, b) => a.sortTime - b.sortTime)
}

/** call_id 仅末尾不同 → 去掉最后一段 `_suffix` 作为 stem */
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
 * 同一 assistant 消息内：call_id 同 stem、且 wall-clock 区间重叠 → 判为并行（含多工具并行）。
 * 返回 callID → 组 id + lane（按 start 升序 0..n-1）。
 */
export function detectParallelCallMapping(messages: OcMessage[], nowMs: number): Map<string, ParallelCallInfo> {
  const out = new Map<string, ParallelCallInfo>()
  type ToolMeta = {
    messageId: string
    callID: string
    stem: string
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
        stem: callIdStem(part.callID),
        window: tw,
        startMs: tw.startMs,
      })
    }
  }
  const byKey = new Map<string, ToolMeta[]>()
  for (const t of tools) {
    const key = `${t.messageId}:::${t.stem}`
    let arr = byKey.get(key)
    if (!arr) {
      arr = []
      byKey.set(key, arr)
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

/** 将并行组 id / lane 写入 mapped action（子会话动作按 parentTaskCallID 继承） */
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
 * 并行子任务共享同一进程带（垂直 band），仅通过 parallelLaneIndex 在 SVG 内错开；
 * 非并行仍按唯一 childSessionID 递增 band。
 */
export function buildChildSessionBandMap(
  descriptors: TaskChildDescriptor[],
  parallelByCallId: Map<string, ParallelCallInfo>
): Map<string, number> {
  const m = new Map<string, number>()
  const groupBand = new Map<string, number>()
  let nextBand = 1
  for (const d of descriptors) {
    const para = parallelByCallId.get(d.callID)
    if (para) {
      const gid = para.parallelGroupId
      if (!groupBand.has(gid)) {
        groupBand.set(gid, nextBand++)
      }
      m.set(d.childSessionID, groupBand.get(gid)!)
    } else {
      if (!m.has(d.childSessionID)) {
        m.set(d.childSessionID, nextBand++)
      }
    }
  }
  return m
}
