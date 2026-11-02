import type { OcMessage, OcMessagePart, ToolPart } from '../types/opencode'
import type { AssistantSubtask } from './subtaskGrouping'
import { parseWebsearchTitleQuery } from './actionTooltipMapping'

/** Matches OpenCode context-panel semantics: per-message token total = input + output + reasoning + cache (see opencode-context-panel.md). */
/**
 * Number of user messages between the assistant after the previous subtask window and this subtask's last assistant index.
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
  /** Equals sum of fields or API `total` when present. */
  total: number
}

export interface SubtaskCardMetrics {
  title: string
  assistantMessageIndices: number[]
  partCount: number
  /** Sum of per-assistant message token totals inside this subtask (segment sum, not delta vs previous subtask; see docs). */
  tokensSegmentSum: number
  tokenBreakdown: SubtaskTokenBreakdown
  llmCallCount: number
  /**
   * **Distinct** file paths touched by write/edit/replace/patch/apply_patch, etc.
   * Deduplicated by path `Set` — **not** the count of write tool invocations.
   */
  mutatedFilePaths: string[]
  mutatedFileCount: number
  /**
   * Read-side approximation: distinct single-path tool inputs (read/grep/list, etc.) + sum of glob `metadata.count`.
   * Includes merged child-session `additionalMessages`. Used for flow-end summaries only — **not** shown in the metric strip.
   */
  readFilesCount: number
  /** Distinct read-tool paths (excludes glob count-only hits). */
  readFilePaths: string[]
  /** Sum of glob tool `meta.count` (approximate matched file count). */
  globMatchFileCount: number
  /** websearch / webfetch query or URL per call (order preserved). */
  webSearchQueries: string[]
  /** websearch / webfetch invocations (equals webSearchQueries.length when every call yields a label). */
  webSearchCallCount: number
  /** Wall-clock span from first `created` to last `completed` (else `created`) in ms. */
  durationMs: number | null
  /** Sum of `info.cost` across assistant messages in this subtask (0 if API omits). */
  costSegmentSum: number
  /**
   * Estimated USD from token breakdown × `TOKEN_COST_RATES_USD` (all rates 0 for now; wire real prices later).
   * If API `cost` is also present, the UI can prefer one or the other.
   */
  costEstimatedUsd: number
  /** Todos newly completed in this segment (= todosNewlyCompleted.length). */
  todosResolvedCount: number
}

/** USD per 1k tokens by kind; all zero until a price table is wired in. */
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

/** Card display: prefer API `cost`; else estimate from breakdown (rates in `TOKEN_COST_RATES_USD_PER_1K`). */
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
 * Read stats: deduped path list + glob file hits (`meta.count`).
 * grep `meta.count` is usually line matches, not files — excluded from file count.
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

/** websearch queries / webfetch URLs in timeline order. */
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

/** Collect write/edit paths across messages (Changes + merged child sessions). */
export function collectMutatedPathsFromMessages(msgs: OcMessage[], into: Set<string>): void {
  for (const m of msgs) {
    for (const part of m.parts) {
      if (part.type === 'tool') collectPathsFromToolPart(part, into)
    }
  }
}

/** End time for one assistant message: `completed`, or extends to `now` while tools are running/pending. */
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
 * Subtask duration: split into **contiguous** assistant index runs on the global timeline;
 * sum each run's first `created` → last end. Gaps while waiting on the user are **excluded**.
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

/** Subtask title: phase label → newly completed todos → first text line → fallback */
export function deriveSubtaskTitle(
  st: AssistantSubtask,
  messages: OcMessage[],
  displayIndex: number
): string {
  if (st.phase === 'planning') {
    return 'Research & plan'
  }
  if (st.phase === 'wrap_up') {
    return 'Wrap-up & output'
  }
  if (st.todosNewlyCompleted.length > 0) {
    const first = st.todosNewlyCompleted[0]!
    // Keep a generous first-todo snippet; the card UI truncates/expands for display.
    const head =
      first.content.length > 120 ? `${first.content.slice(0, 120).trimEnd()}…` : first.content
    const more =
      st.todosNewlyCompleted.length > 1 ? ` +${st.todosNewlyCompleted.length - 1} more` : ''
    return `Done: ${head}${more}`
  }
  const firstIdx = st.assistantMessageIndices[0]
  if (firstIdx !== undefined) {
    const msg = messages[firstIdx]
    if (msg) {
      for (const p of msg.parts) {
        if (p.type === 'text' && p.text?.trim()) {
          // Prefer the full first line (capped) so expand-to-wrap can show the real title.
          const line = p.text.trim().split(/\n/)[0]!
          if (line.length > 200) return `${line.slice(0, 200).trimEnd()}…`
          return line
        }
      }
    }
  }
  return `Subtask ${displayIndex + 1}`
}

/** Subtask duration label (em dash when unknown) */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  return `${m}m${rs > 0 ? `${rs}s` : ''}`
}

/** Wall-clock span for a flat assistant message list (no global index gaps to exclude). */
export function computeDurationFromMessages(
  msgs: OcMessage[],
  nowMs: number,
): number | null {
  const assistants = msgs.filter((m) => m.info.role === 'assistant')
  if (assistants.length === 0) return null
  let minCreated = Infinity
  let maxEnd = -Infinity
  for (const m of assistants) {
    const c = m.info.time.created
    const e = assistantMessageEndMs(m, nowMs)
    minCreated = Math.min(minCreated, c)
    maxEnd = Math.max(maxEnd, e)
  }
  if (!Number.isFinite(minCreated) || maxEnd < minCreated) return null
  const ms = maxEnd - minCreated
  return ms > 0 ? ms : null
}

/**
 * Core strip / flow-end metrics from concrete message objects (used by live cards and fork prefix merge).
 */
export function buildSubtaskCardMetricsFromMessages(opts: {
  title: string
  assistantMessages: OcMessage[]
  additionalMessages?: OcMessage[]
  assistantMessageIndices?: number[]
  todosResolvedCount?: number
  nowMs?: number
  /** When set with `allMessages`, duration excludes user gaps between contiguous assistant index runs. */
  durationAssistantIndices?: number[]
  durationAllMessages?: OcMessage[]
}): SubtaskCardMetrics {
  const msgs = opts.assistantMessages
  const additional = opts.additionalMessages ?? []
  const nowMs = opts.nowMs ?? Date.now()

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
  if (additional.length) {
    collectMutatedPathsFromMessages(additional, paths)
  }
  const mutatedFilePaths = [...paths].sort()

  const allForRead: OcMessage[] = [...msgs, ...additional]
  const readStats = collectReadFileStatsFromMessages(allForRead)
  const readFilePaths = readStats.readPathsSorted
  const globMatchFileCount = readStats.globFileHits
  const readFilesCount = readFilePaths.length + globMatchFileCount
  const webSearchQueries = collectWebSearchQueriesFromMessages(allForRead)
  const webSearchCallCount = webSearchQueries.length

  const durationMs =
    opts.durationAssistantIndices && opts.durationAllMessages
      ? computeSubtaskDurationExcludingUserGaps(
          opts.durationAssistantIndices,
          opts.durationAllMessages,
          nowMs,
        )
      : computeDurationFromMessages(msgs, nowMs)

  return {
    title: opts.title,
    assistantMessageIndices: opts.assistantMessageIndices ? [...opts.assistantMessageIndices] : [],
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
    todosResolvedCount: opts.todosResolvedCount ?? 0,
  }
}

/** Add two metric strips (fork prefix + live branch). Durations sum (user gap between them stays excluded). */
export function mergeSubtaskCardMetrics(
  prefix: SubtaskCardMetrics,
  live: SubtaskCardMetrics,
): SubtaskCardMetrics {
  const bd: SubtaskTokenBreakdown = {
    input: prefix.tokenBreakdown.input + live.tokenBreakdown.input,
    output: prefix.tokenBreakdown.output + live.tokenBreakdown.output,
    reasoning: prefix.tokenBreakdown.reasoning + live.tokenBreakdown.reasoning,
    cacheRead: prefix.tokenBreakdown.cacheRead + live.tokenBreakdown.cacheRead,
    cacheWrite: prefix.tokenBreakdown.cacheWrite + live.tokenBreakdown.cacheWrite,
    total: 0,
  }
  bd.total = bd.input + bd.output + bd.reasoning + bd.cacheRead + bd.cacheWrite

  const mutatedPaths = new Set([...prefix.mutatedFilePaths, ...live.mutatedFilePaths])
  const mutatedFilePaths = [...mutatedPaths].sort()
  const readPaths = new Set([...prefix.readFilePaths, ...live.readFilePaths])
  const readFilePaths = [...readPaths].sort()
  const globMatchFileCount = prefix.globMatchFileCount + live.globMatchFileCount
  const webSearchQueries = [...prefix.webSearchQueries, ...live.webSearchQueries]

  const durationParts = [prefix.durationMs, live.durationMs].filter(
    (v): v is number => v != null && Number.isFinite(v) && v >= 0,
  )
  const durationMs = durationParts.length ? durationParts.reduce((a, b) => a + b, 0) : null

  return {
    title: live.title,
    assistantMessageIndices: [...prefix.assistantMessageIndices, ...live.assistantMessageIndices],
    partCount: prefix.partCount + live.partCount,
    tokensSegmentSum: prefix.tokensSegmentSum + live.tokensSegmentSum,
    tokenBreakdown: bd,
    llmCallCount: prefix.llmCallCount + live.llmCallCount,
    mutatedFilePaths,
    mutatedFileCount: mutatedFilePaths.length,
    readFilesCount: readFilePaths.length + globMatchFileCount,
    readFilePaths,
    globMatchFileCount,
    webSearchQueries,
    webSearchCallCount: webSearchQueries.length,
    durationMs,
    costSegmentSum: prefix.costSegmentSum + live.costSegmentSum,
    costEstimatedUsd: estimateCostUsdFromTokenBreakdown(bd),
    todosResolvedCount: prefix.todosResolvedCount + live.todosResolvedCount,
  }
}

export function buildSubtaskCardMetrics(
  st: AssistantSubtask,
  messages: OcMessage[],
  displayIndex: number,
  options?: {
    nowMs?: number
    /** Child session messages (task/subagent): merged into Changes (write/edit paths). */
    additionalMessages?: OcMessage[]
  },
): SubtaskCardMetrics {
  const indices = st.assistantMessageIndices
  const msgs = indices.map((i) => messages[i]).filter((m): m is OcMessage => !!m)
  return buildSubtaskCardMetricsFromMessages({
    title: deriveSubtaskTitle(st, messages, displayIndex),
    assistantMessages: msgs,
    additionalMessages: options?.additionalMessages,
    assistantMessageIndices: indices,
    todosResolvedCount: st.todosNewlyCompleted.length,
    nowMs: options?.nowMs,
    durationAssistantIndices: indices,
    durationAllMessages: messages,
  })
}

/** Message + part refs for this subtask (for downstream visualization). */
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
