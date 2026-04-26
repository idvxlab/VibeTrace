import type { OcMessage, OcMessagePart, ToolPart } from '../types/opencode'
import type { AssistantSubtask } from './subtaskGrouping'
import { parseWebsearchTitleQuery } from './actionTooltipMapping'

/** 与 OpenCode 上下文面板一致的「单条 message token 合计」：input+output+reasoning+cache（见 opencode-context-panel.md） */
/**
 * 从「上一子任务最后一条 assistant 之后」到「本子任务最后一条 assistant」下标范围内，user message 条数。
 */
export function countUserMessagesInSubtaskWindow(
  messages: OcMessage[],
  assistantIndices: number[],
  prevSubtaskMaxAssistantIndex: number | null | undefined
): number {
  if (assistantIndices.length === 0) return 0
  const maxA = Math.max(...assistantIndices)
  const start = prevSubtaskMaxAssistantIndex == null ? 0 : prevSubtaskMaxAssistantIndex + 1
  let n = 0
  for (let i = start; i <= maxA; i++) {
    if (messages[i]?.info.role === 'user') n++
  }
  return n
}

export function tokenTotalForMessage(tokens: OcMessage['info']['tokens'] | undefined): number {
  if (!tokens) return 0
  if (typeof tokens.total === 'number' && tokens.total > 0) {
    return tokens.total
  }
  const c = tokens.cache
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (c?.read ?? 0) +
    (c?.write ?? 0)
  )
}

export interface SubtaskTokenBreakdown {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** 与分项之和一致（或来自 API total） */
  total: number
}

export interface SubtaskCardMetrics {
  title: string
  assistantMessageIndices: number[]
  partCount: number
  /** 本子任务内各 assistant message 的 token 合计之和（非「相对上一子任务的增量」，见文档） */
  tokensSegmentSum: number
  tokenBreakdown: SubtaskTokenBreakdown
  llmCallCount: number
  /**
   * 本子任务内 **去重后的文件路径数**（来自 write/edit/replace/patch/apply_patch 等），
   * 按路径 `Set` 去重，**不是**「写操作调用次数」。
   */
  mutatedFilePaths: string[]
  mutatedFileCount: number
  /**
   * 读侧近似：单路径工具（read/grep/list 等 input 路径）去重数 + glob 的 metadata.count 之和（扫到的文件数近似）。
   * 合并子会话 `additionalMessages`。仅用于流程终点摘要等，**不在**指标栏展示。
   */
  readFilesCount: number
  /** 读工具去重后的路径列表（不含 glob 仅计数的部分） */
  readFilePaths: string[]
  /** glob 工具 meta.count 之和（近似匹配文件数） */
  globMatchFileCount: number
  /** websearch / webfetch 每次调用的关键词或 URL（顺序保留） */
  webSearchQueries: string[]
  /** websearch / webfetch 调用次数（等于 webSearchQueries.length 若每次都能解析出标签） */
  webSearchCallCount: number
  /** 首条 created → 末条 completed（无则用 created）的跨度 ms */
  durationMs: number | null
  /** 本子任务内各 assistant message 的 `info.cost` 之和（API 未给则为 0） */
  costSegmentSum: number
  /**
   * 按单价从 token 分项估算的美元成本（与 `TOKEN_COST_RATES_USD` 相乘后求和；当前单价均为 0，占位供以后接模型价目表）。
   * 若将来与 API `cost` 并存，UI 可优先展示 API 或二者择一。
   */
  costEstimatedUsd: number
  /** 本段解决的 todo 数（= todosNewlyCompleted.length） */
  todosResolvedCount: number
}

/** 每千 token 美元单价占位：input/output/reasoning/cache read/cache write 可分别定价；当前全 0 */
export const TOKEN_COST_RATES_USD_PER_1K = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const

export function estimateCostUsdFromTokenBreakdown(bd: SubtaskTokenBreakdown): number {
  const r = TOKEN_COST_RATES_USD_PER_1K
  return (
    (bd.input / 1000) * r.input +
    (bd.output / 1000) * r.output +
    (bd.reasoning / 1000) * r.reasoning +
    (bd.cacheRead / 1000) * r.cacheRead +
    (bd.cacheWrite / 1000) * r.cacheWrite
  )
}

/** 卡片展示：优先 API 累计 cost；否则用分项估算（单价见 `TOKEN_COST_RATES_USD_PER_1K`） */
export function formatSubtaskCostDisplay(m: {
  costSegmentSum: number
  costEstimatedUsd: number
}): string {
  if (m.costSegmentSum > 0) {
    return `$${m.costSegmentSum.toFixed(4)}`
  }
  return `$${m.costEstimatedUsd.toFixed(2)}`
}

function isFileMutatingTool(toolName: string): boolean {
  const t = toolName.toLowerCase()
  if (t.includes('write') || t.includes('edit') || t.includes('replace') || t.includes('patch')) {
    return true
  }
  if (t === 'apply_patch' || t.includes('apply_patch')) return true
  return false
}

function extractPathFromToolInput(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null
  const keys = ['path', 'file_path', 'target_file', 'filepath', 'filePath']
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function normalizeToolNameLocal(tool: string): string {
  return tool.trim().toLowerCase().replace(/-/g, '_')
}

function strInput(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}

/**
 * 统计「读」相关：路径去重列表 + glob 结果文件数（meta.count）。
 * grep 的 meta.count 多为匹配行数，不计入「文件数」。
 */
function collectReadFileStatsFromMessages(msgs: OcMessage[]): { readPathsSorted: string[]; globFileHits: number } {
  const paths = new Set<string>()
  let globFileHits = 0
  for (const m of msgs) {
    for (const part of m.parts) {
      if (part.type !== 'tool') continue
      const t = normalizeToolNameLocal(part.tool)
      const meta = part.state?.metadata as Record<string, unknown> | undefined
      const cnt = meta?.count
      if (t === 'glob') {
        if (typeof cnt === 'number' && cnt > 0) {
          globFileHits += cnt
        } else {
          const p = extractPathFromToolInput(part.state?.input as Record<string, unknown> | undefined)
          if (p) paths.add(p)
        }
        continue
      }
      if (t === 'grep' || t === 'read' || t === 'read_file' || t === 'list' || t === 'codesearch') {
        const p = extractPathFromToolInput(part.state?.input as Record<string, unknown> | undefined)
        if (p) paths.add(p)
      }
    }
  }
  return { readPathsSorted: [...paths].sort(), globFileHits }
}

/** websearch 关键词 / webfetch URL，按时间顺序 */
function collectWebSearchQueriesFromMessages(msgs: OcMessage[]): string[] {
  const out: string[] = []
  for (const m of msgs) {
    for (const part of m.parts) {
      if (part.type !== 'tool') continue
      const t = normalizeToolNameLocal(part.tool)
      if (t !== 'websearch' && t !== 'web_search' && t !== 'webfetch' && t !== 'web_fetch') continue
      const input = part.state?.input as Record<string, unknown> | undefined
      const st = part.state as { title?: string } | undefined
      if (t === 'websearch' || t === 'web_search') {
        const q = strInput(input?.query) ?? parseWebsearchTitleQuery(st?.title)
        if (q) out.push(q)
        else out.push('(empty query)')
      } else {
        const url = strInput(input?.url) ?? strInput(st?.title)
        if (url) out.push(url)
        else out.push('(empty url)')
      }
    }
  }
  return out
}

function collectPathsFromToolPart(part: ToolPart, into: Set<string>) {
  if (!isFileMutatingTool(part.tool)) return
  const p = extractPathFromToolInput(part.state?.input as Record<string, unknown> | undefined)
  if (p) into.add(p)
}

/** 从多条消息中收集 write/edit 等工具涉及的路径（用于 Changes 与子会话合并） */
export function collectMutatedPathsFromMessages(msgs: OcMessage[], into: Set<string>): void {
  for (const m of msgs) {
    for (const part of m.parts) {
      if (part.type === 'tool') collectPathsFromToolPart(part, into)
    }
  }
}

/** 单条 assistant 消息的「结束」时间：completed 或 running 工具则延伸到 now */
function assistantMessageEndMs(msg: OcMessage, nowMs: number): number {
  const c = msg.info.time.created
  let e = msg.info.time.completed ?? c
  for (const p of msg.parts) {
    if (p.type !== 'tool') continue
    const st = p.state?.status
    if (st !== 'running' && st !== 'pending') continue
    const start = p.state?.time?.start ?? c
    if (typeof start === 'number' && Number.isFinite(start)) {
      e = Math.max(e, nowMs)
    }
  }
  return e
}

/**
 * 子任务时长：按全局时间轴上 **连续** assistant 下标分段，各段内部「首 created → 末 end」相加；
 * **不**把 user 消息插在中间时的间隔算进去（等待用户输入的时间）。
 */
export function computeSubtaskDurationExcludingUserGaps(
  assistantIndices: number[],
  allMessages: OcMessage[],
  nowMs: number,
): number | null {
  if (assistantIndices.length === 0) return null
  const sorted = [...new Set(assistantIndices)].sort((a, b) => a - b)
  const chunks: number[][] = []
  let cur: number[] = [sorted[0]!]
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const idx = sorted[i]!
    if (idx === prev + 1) {
      cur.push(idx)
    } else {
      chunks.push(cur)
      cur = [idx]
    }
  }
  chunks.push(cur)

  let sum = 0
  for (const chunk of chunks) {
    const msgs = chunk.map((i) => allMessages[i]).filter((m): m is OcMessage => m != null)
    if (msgs.length === 0) continue
    let minCreated = Infinity
    let maxEnd = -Infinity
    for (const m of msgs) {
      const c = m.info.time.created
      const e = assistantMessageEndMs(m, nowMs)
      minCreated = Math.min(minCreated, c)
      maxEnd = Math.max(maxEnd, e)
    }
    if (Number.isFinite(minCreated) && maxEnd >= minCreated) {
      sum += maxEnd - minCreated
    }
  }
  return sum > 0 ? sum : null
}

function countPartsInMessages(messages: OcMessage[]): number {
  let n = 0
  for (const m of messages) {
    n += m.parts.length
  }
  return n
}

/** 子任务标题：阶段固定名 → 「新完成的 todo」→ 首条 text → 默认 */
export function deriveSubtaskTitle(
  st: AssistantSubtask,
  messages: OcMessage[],
  displayIndex: number
): string {
  if (st.phase === 'planning') {
    return '前期调研与计划生成'
  }
  if (st.phase === 'wrap_up') {
    return '总结归纳与结果输出'
  }
  if (st.todosNewlyCompleted.length > 0) {
    const first = st.todosNewlyCompleted[0]!
    const head = first.content.length > 36 ? `${first.content.slice(0, 36)}…` : first.content
    const more =
      st.todosNewlyCompleted.length > 1 ? ` 等 ${st.todosNewlyCompleted.length} 项` : ''
    return `完成：${head}${more}`
  }
  const firstIdx = st.assistantMessageIndices[0]
  if (firstIdx !== undefined) {
    const msg = messages[firstIdx]
    if (msg) {
      for (const p of msg.parts) {
        if (p.type === 'text' && p.text?.trim()) {
          const line = p.text.trim().split(/\n/)[0]!.slice(0, 44)
          return line.length >= 44 ? `${line}…` : line
        }
      }
    }
  }
  return `子任务 ${displayIndex + 1}`
}

/** 子任务时间跨度展示（无数据时 —） */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  return `${m}m${rs > 0 ? `${rs}s` : ''}`
}

export function buildSubtaskCardMetrics(
  st: AssistantSubtask,
  messages: OcMessage[],
  displayIndex: number,
  options?: {
    nowMs?: number
    /** task/subagent 子会话拉取到的消息：合并计入 Changes（write/edit 路径） */
    additionalMessages?: OcMessage[]
  },
): SubtaskCardMetrics {
  const indices = st.assistantMessageIndices
  const msgs = indices.map(i => messages[i]).filter((m): m is OcMessage => !!m)

  const bd: SubtaskTokenBreakdown = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  }

  let tokensSegmentSum = 0
  for (const m of msgs) {
    const t = m.info.tokens
    if (t) {
      bd.input += t.input ?? 0
      bd.output += t.output ?? 0
      bd.reasoning += t.reasoning ?? 0
      bd.cacheRead += t.cache?.read ?? 0
      bd.cacheWrite += t.cache?.write ?? 0
    }
    tokensSegmentSum += tokenTotalForMessage(m.info.tokens)
  }
  bd.total = bd.input + bd.output + bd.reasoning + bd.cacheRead + bd.cacheWrite

  let costSegmentSum = 0
  for (const m of msgs) {
    const c = m.info.cost
    if (typeof c === 'number' && Number.isFinite(c)) {
      costSegmentSum += c
    }
  }
  const costEstimatedUsd = estimateCostUsdFromTokenBreakdown(bd)

  const paths = new Set<string>()
  collectMutatedPathsFromMessages(msgs, paths)
  if (options?.additionalMessages?.length) {
    collectMutatedPathsFromMessages(options.additionalMessages, paths)
  }
  const mutatedFilePaths = [...paths].sort()

  const allForRead: OcMessage[] = [...msgs, ...(options?.additionalMessages ?? [])]
  const readStats = collectReadFileStatsFromMessages(allForRead)
  const readFilePaths = readStats.readPathsSorted
  const globMatchFileCount = readStats.globFileHits
  const readFilesCount = readFilePaths.length + globMatchFileCount
  const webSearchQueries = collectWebSearchQueriesFromMessages(allForRead)
  const webSearchCallCount = webSearchQueries.length

  const nowMs = options?.nowMs ?? Date.now()
  const durationMs = computeSubtaskDurationExcludingUserGaps(indices, messages, nowMs)

  return {
    title: deriveSubtaskTitle(st, messages, displayIndex),
    assistantMessageIndices: [...indices],
    partCount: countPartsInMessages(msgs),
    tokensSegmentSum,
    tokenBreakdown: bd,
    llmCallCount: msgs.length,
    mutatedFilePaths,
    mutatedFileCount: mutatedFilePaths.length,
    readFilesCount,
    readFilePaths,
    globMatchFileCount,
    webSearchQueries,
    webSearchCallCount,
    durationMs,
    costSegmentSum,
    costEstimatedUsd,
    todosResolvedCount: st.todosNewlyCompleted.length,
  }
}

/** 供后续可视化：本子任务涉及的 message + part 引用 */
export function getSubtaskMessagesAndParts(
  st: AssistantSubtask,
  messages: OcMessage[]
): { messageIndex: number; message: OcMessage; parts: OcMessagePart[] }[] {
  return st.assistantMessageIndices
    .map(i => {
      const message = messages[i]
      if (!message) return null
      return { messageIndex: i, message, parts: message.parts }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
}
