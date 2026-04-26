/**
 * Action-flow tooltip: English-only labels. Resolves part via `partId` + merged messages.
 */

import type { MappedAction, OcMessage, OcMessagePart, ToolPart } from '../types/opencode'

/** @deprecated Prefer TooltipBodyLine + buildEnglishTooltipContent */
export type TooltipKeyValue = {
  key: string
  value: string
  sourceHint?: string
}

export type TooltipBodyLine =
  | { kind: 'kv'; key: string; value: string }
  | { kind: 'text'; value: string }
  /** `question` tool: label "About:" + one line per header */
  | { kind: 'about'; headers: string[] }
  /** Full error text (no truncation); rendered with `pre-wrap` + scroll in CSS */
  | { kind: 'error'; value: string }

export type EnglishTooltipContent = {
  /** Bold first token: `part.type` or tool name for `tool` */
  primaryLabel: string
  /** Status text (no key) */
  statusLabel: string
  body: TooltipBodyLine[]
}

const URL_LIST_MAX = 8
/** Assistant `text` / `reasoning` tooltip body: first N words, then ellipsis */
const PREVIEW_MAX_WORDS = 300

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, '_')
}

/** First `maxWords` word-like segments (Intl.Segmenter); fallback: whitespace tokens. */
function truncateToMaxWords(s: string, maxWords: number): string {
  const t = s.trim()
  if (!t) return t
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: 'word' })
      let wordCount = 0
      const out: string[] = []
      for (const part of seg.segment(t)) {
        if (part.isWordLike) {
          if (wordCount >= maxWords) {
            return out.join('') + '…'
          }
          wordCount++
        }
        out.push(part.segment)
      }
      return t
    } catch {
      /* fall through */
    }
  }
  const words = t.split(/\s+/)
  if (words.length <= maxWords) return t
  return words.slice(0, maxWords).join(' ') + '…'
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** String field including empty `""` (e.g. `state.title`) */
function stringField(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function formatToolError(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err, null, 2)
  } catch {
    return String(err)
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** websearch output: count lines starting with `URL:` */
export function countUrlLinesInToolOutput(output: string | undefined): number {
  if (!output) return 0
  const m = output.match(/^URL:\s*\S+/gm)
  return m?.length ?? 0
}

export function extractUrlsFromSearchOutput(output: string | undefined, limit = URL_LIST_MAX): string[] {
  if (!output) return []
  const re = /^URL:\s*(https?:\/\/\S+)/gm
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) && out.length < limit) {
    out.push(m[1]!)
  }
  return out
}

export function parseWebsearchTitleQuery(title: string | undefined): string | undefined {
  if (!title) return undefined
  const m = title.match(/^Web\s*search:\s*(.+)$/i)
  return m?.[1]?.trim() || undefined
}

type TodoRaw = { status?: string; content?: string; id?: string }

function countCompleted(todos: TodoRaw[]): number {
  return todos.filter((t) => (t.status ?? '') === 'completed').length
}

function countPending(todos: TodoRaw[]): number {
  return todos.filter((t) => {
    const s = (t.status ?? '').toLowerCase()
    return s === 'pending' || s === 'in_progress'
  }).length
}

function getTodosArray(part: ToolPart): TodoRaw[] {
  const meta = part.state?.metadata as Record<string, unknown> | undefined
  const input = part.state?.input as Record<string, unknown> | undefined
  const raw = meta?.todos ?? input?.todos
  return Array.isArray(raw) ? (raw as TodoRaw[]) : []
}

/** All `todowrite` tool parts in timeline order (assistant messages only). */
function collectTodowriteToolParts(messages: OcMessage[]): ToolPart[] {
  const out: ToolPart[] = []
  for (const message of messages) {
    if (message.info.role !== 'assistant') continue
    for (const p of message.parts) {
      if (p.type === 'tool' && normalizeToolName(p.tool) === 'todowrite') {
        out.push(p)
      }
    }
  }
  return out
}

function buildTodowriteLines(part: ToolPart, allMessages: OcMessage[] | undefined): TooltipBodyLine[] {
  const curr = getTodosArray(part)
  const msgs = allMessages ?? []
  const list = collectTodowriteToolParts(msgs)
  const idx = list.findIndex((p) => p.id === part.id)
  const prev = idx > 0 ? getTodosArray(list[idx - 1]!) : undefined
  const isInitial = idx <= 0

  const prevCompleted = prev ? countCompleted(prev) : 0
  const currCompleted = countCompleted(curr)
  const currPending = countPending(curr)
  const total = curr.length
  const completedThisRun = Math.max(0, currCompleted - prevCompleted)

  const lines: TooltipBodyLine[] = [
    {
      kind: 'kv',
      key: 'Operation',
      value: isInitial ? 'Initial todo list' : 'Update todo list',
    },
    {
      kind: 'kv',
      key: 'Completed this run',
      value: String(completedThisRun),
    },
    {
      kind: 'kv',
      key: 'Total completed',
      value: `${currCompleted} / ${total}`,
    },
    {
      kind: 'kv',
      key: 'Pending',
      value: String(currPending),
    },
  ]
  return lines
}

function getToolStatus(part: ToolPart): string {
  const s = part.state?.status
  if (s === 'error') return 'error'
  return s ?? 'unknown'
}

function getNonToolStatus(_part: OcMessagePart): string {
  return 'completed'
}

/** Bold label: tool name or `part.type` */
export function getPrimaryLabel(part: OcMessagePart): string {
  if (part.type === 'tool') return part.tool
  return part.type
}

export function getStatusLabel(part: OcMessagePart): string {
  if (part.type === 'tool') return getToolStatus(part)
  return getNonToolStatus(part)
}

function englishToolBody(part: ToolPart, ctx: { allMessages?: OcMessage[] }): TooltipBodyLine[] {
  const tool = normalizeToolName(part.tool)
  const st = part.state
  const status = st?.status ?? 'unknown'
  const input = (st?.input ?? {}) as Record<string, unknown>
  const meta = (st?.metadata ?? {}) as Record<string, unknown>
  const err = st?.error

  if (status === 'error') {
    const full = formatToolError(err)
    return [{ kind: 'error', value: full || '(no error message)' }]
  }

  switch (tool) {
    case 'read': {
      const fpRaw = stringField(input.filePath as string | undefined) ?? stringField(st?.title as string | undefined)
      const lines: TooltipBodyLine[] = []
      if (fpRaw !== undefined) {
        lines.push({
          kind: 'kv',
          key: 'Read file',
          value: fpRaw === '' ? '(empty)' : fpRaw,
        })
      }
      return lines
    }
    case 'write': {
      const pathRaw =
        stringField(st?.title as string | undefined) ?? stringField(input.filePath as string | undefined)
      const outRaw = stringField(st?.output as string | undefined)
      const lines: TooltipBodyLine[] = []
      if (pathRaw !== undefined) {
        lines.push({
          kind: 'kv',
          key: 'Write file',
          value: pathRaw === '' ? '(empty)' : pathRaw,
        })
      }
      if (outRaw !== undefined) {
        lines.push({ kind: 'text', value: outRaw === '' ? '(empty)' : outRaw })
      }
      return lines
    }
    case 'edit': {
      const fpRaw = stringField(input.filePath as string | undefined) ?? stringField(st?.title as string | undefined)
      const outRaw = stringField(st?.output as string | undefined)
      const lines: TooltipBodyLine[] = []
      if (fpRaw !== undefined) {
        lines.push({
          kind: 'kv',
          key: 'Edit file',
          value: fpRaw === '' ? '(empty)' : fpRaw,
        })
      }
      if (outRaw !== undefined) {
        lines.push({ kind: 'text', value: outRaw === '' ? '(empty)' : outRaw })
      }
      return lines
    }
    case 'todowrite':
    case 'todoread':
    case 'todo_read':
      return buildTodowriteLines(part, ctx.allMessages)
    case 'bash':
    case 'shell': {
      const lines: TooltipBodyLine[] = []
      const titleRaw = stringField(st?.title as string | undefined)
      if (titleRaw !== undefined) {
        lines.push({ kind: 'text', value: titleRaw === '' ? '(empty)' : titleRaw })
      }
      const cmdRaw = stringField(input.command as string | undefined)
      if (cmdRaw !== undefined) {
        lines.push({ kind: 'kv', key: 'command', value: cmdRaw === '' ? '(empty)' : cmdRaw })
      }
      return lines
    }
    case 'task':
    case 'subtask':
    case 'subagent':
    case 'agent': {
      const stypeRaw = stringField(input.subagent_type as string | undefined)
      const descRaw = stringField(input.description as string | undefined)
      const titleRaw = stringField(st?.title as string | undefined)
      const lines: TooltipBodyLine[] = []
      if (titleRaw !== undefined) {
        lines.push({
          kind: 'kv',
          key: 'title',
          value: titleRaw === '' ? '(empty)' : titleRaw,
        })
      }
      if (stypeRaw !== undefined) {
        lines.push({
          kind: 'kv',
          key: 'subagent',
          value: stypeRaw === '' ? '(empty)' : stypeRaw,
        })
      }
      if (descRaw !== undefined) {
        lines.push({
          kind: 'kv',
          key: 'description',
          value: descRaw === '' ? '(empty)' : descRaw,
        })
      }
      return lines
    }
    case 'grep': {
      const pat = str(input.pattern) ?? ''
      const cnt = num(meta.count)
      const lines: TooltipBodyLine[] = [{ kind: 'kv', key: 'Match', value: pat }]
      if (cnt === 0) lines.push({ kind: 'kv', key: 'result num', value: 'No files found' })
      else lines.push({ kind: 'kv', key: 'result num', value: cnt !== undefined ? String(cnt) : '—' })
      return lines
    }
    case 'glob': {
      const pat = str(input.pattern) ?? '*'
      const cnt = num(meta.count)
      const lines: TooltipBodyLine[] = [{ kind: 'kv', key: 'Match', value: pat }]
      if (cnt === 0) lines.push({ kind: 'kv', key: 'result num', value: 'No files found' })
      else lines.push({ kind: 'kv', key: 'result num', value: cnt !== undefined ? String(cnt) : '—' })
      return lines
    }
    case 'webfetch': {
      const lines: TooltipBodyLine[] = []
      const t = stringField(st?.title as string | undefined)
      const url = stringField(input.url as string | undefined)
      if (t !== undefined) lines.push({ kind: 'kv', key: 'Web fetch', value: t === '' ? '(empty)' : t })
      if (url !== undefined) lines.push({ kind: 'kv', key: 'URL', value: url === '' ? '(empty)' : url })
      return lines
    }
    case 'websearch': {
      const titleForQuery = typeof st?.title === 'string' ? st.title : undefined
      const q = str(input.query) ?? parseWebsearchTitleQuery(titleForQuery)
      const nReq = num(input.numResults)
      const outRaw = stringField(st?.output as string | undefined)
      const lines: TooltipBodyLine[] = []
      lines.push({ kind: 'kv', key: 'web search', value: q ?? '(empty)' })
      if (nReq !== undefined) lines.push({ kind: 'kv', key: 'results num', value: String(nReq) })
      if (outRaw) {
        const urls = extractUrlsFromSearchOutput(outRaw, URL_LIST_MAX)
        for (const u of urls) {
          lines.push({ kind: 'kv', key: 'URL', value: u })
        }
      }
      return lines
    }
    case 'list': {
      const p = str(input.path)
      if (p) return [{ kind: 'kv', key: 'List directory', value: p }]
      return []
    }
    case 'codesearch': {
      const q = str(input.query)
      if (q) return [{ kind: 'kv', key: 'Search', value: q }]
      return []
    }
    case 'question': {
      const qs = input.questions as Array<{ header?: string }> | undefined
      const lines: TooltipBodyLine[] = []
      if (Array.isArray(qs)) {
        lines.push({ kind: 'kv', key: 'Answered questions', value: String(qs.length) })
        const headers = qs.map((q) => (typeof q?.header === 'string' ? q.header : ''))
        lines.push({ kind: 'about', headers })
      }
      return lines
    }
    case 'skill': {
      const n = str(input.name)
      if (n) return [{ kind: 'kv', key: 'Skill', value: n }]
      return []
    }
    case 'apply_patch': {
      const files = meta.files
      if (Array.isArray(files)) {
        return [{ kind: 'kv', key: 'Files', value: String(files.length) }]
      }
      const patchTitle = stringField(st?.title as string | undefined)
      if (patchTitle !== undefined) {
        return [{ kind: 'kv', key: 'Patch', value: patchTitle === '' ? '(empty)' : patchTitle }]
      }
      return []
    }
    default: {
      const lines: TooltipBodyLine[] = []
      const titleRaw = stringField(st?.title as string | undefined)
      const outRaw = stringField(st?.output as string | undefined)
      if (titleRaw !== undefined) {
        lines.push({ kind: 'kv', key: 'Title', value: titleRaw === '' ? '(empty)' : titleRaw })
      }
      if (outRaw !== undefined) {
        lines.push({ kind: 'kv', key: 'Output', value: outRaw === '' ? '(empty)' : outRaw })
      }
      return lines
    }
  }
}

function englishNonToolBody(part: OcMessagePart): TooltipBodyLine[] {
  switch (part.type) {
    case 'reasoning': {
      const text = part.text?.trim() ?? ''
      if (!text) return [{ kind: 'text', value: '(empty)' }]
      return [{ kind: 'text', value: truncateToMaxWords(text, PREVIEW_MAX_WORDS) }]
    }
    case 'text': {
      const text = part.text?.trim() ?? ''
      if (!text) return [{ kind: 'text', value: '(empty)' }]
      return [{ kind: 'text', value: truncateToMaxWords(text, PREVIEW_MAX_WORDS) }]
    }
    case 'compaction':
      return [{ kind: 'kv', key: 'Note', value: 'Context compaction (summary may follow in session).' }]
    default:
      return [{ kind: 'kv', key: 'Part', value: part.type }]
  }
}

export function buildEnglishTooltipContent(
  part: OcMessagePart,
  ctx: { allMessages?: OcMessage[] } = {}
): EnglishTooltipContent {
  const primaryLabel = getPrimaryLabel(part)
  const statusLabel = getStatusLabel(part)

  if (part.type === 'tool') {
    return {
      primaryLabel,
      statusLabel,
      body: englishToolBody(part, ctx),
    }
  }
  return {
    primaryLabel,
    statusLabel,
    body: englishNonToolBody(part),
  }
}

export function formatEnglishTooltipContentHtml(content: EnglishTooltipContent, escapeHtml: (s: string) => string): string {
  const head = `<div class="action-tip-head"><strong class="action-tip-primary">${escapeHtml(content.primaryLabel)}</strong><span class="action-tip-status">${escapeHtml(content.statusLabel)}</span></div>`
  const bodyHtml = content.body
    .map((line) => {
      if (line.kind === 'kv') {
        return `<div class="action-tip-kv"><span class="action-tip-k">${escapeHtml(line.key)}</span><span class="action-tip-v">${escapeHtml(line.value)}</span></div>`
      }
      if (line.kind === 'about') {
        const headersHtml = line.headers
          .map((h) => `<div class="action-tip-about-line">${escapeHtml(h)}</div>`)
          .join('')
        return `<div class="action-tip-about"><div class="action-tip-about-label">About:</div>${headersHtml}</div>`
      }
      if (line.kind === 'error') {
        return `<div class="action-tip-error">${escapeHtml(line.value)}</div>`
      }
      return `<div class="action-tip-text">${escapeHtml(line.value)}</div>`
    })
    .join('')
  return `${head}<div class="action-tip-body">${bodyHtml}</div>`
}

/**
 * @deprecated legacy Chinese KV builder
 */
export function buildTooltipKeyValuesFromPart(part: OcMessagePart, _ctx?: { cwd?: string }): TooltipKeyValue[] {
  const c = buildEnglishTooltipContent(part, {})
  return c.body
    .filter((l): l is { kind: 'kv'; key: string; value: string } => l.kind === 'kv')
    .map((l) => ({ key: l.key, value: l.value }))
}

export function mergeMessagesForActionTooltipLookup(
  segmentMessages: OcMessage[],
  childBranchMessages: OcMessage[]
): OcMessage[] {
  return [...segmentMessages, ...childBranchMessages]
}

export function resolvePartForAction(
  allMessages: OcMessage[],
  act: Pick<MappedAction, 'partId' | 'messageIndex' | 'partIndex' | 'messageID'>,
): OcMessagePart | undefined {
  if (act.partId) {
    for (const msg of allMessages) {
      const p = msg.parts.find((pr) => pr.id === act.partId)
      if (p) return p
    }
  }
  /**
   * 子会话动作来自 `buildMappedActionsFromMessages(childMessages)`，其 `messageIndex` 是
   * **该子数组** 的下标，与 `mergeMessagesForActionTooltipLookup` 的扁平顺序不一致。
   * 用 assistant 消息的 `messageID` + `partIndex` 在合并表上唯一定位。
   */
  if (act.messageID && act.partIndex !== undefined) {
    for (const msg of allMessages) {
      if (msg.info.id === act.messageID) {
        return msg.parts[act.partIndex]
      }
    }
  }
  if (act.messageIndex !== undefined && act.partIndex !== undefined) {
    const msg = allMessages[act.messageIndex]
    if (!msg || msg.info.role !== 'assistant') return undefined
    return msg.parts[act.partIndex]
  }
  return undefined
}

function escapeForActionTooltip(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Action flow 与 treemap 共用的 compact tooltip：正文优先来自消息 part 解析，失败时退化为
 * `actionType` / `status` / `detail`；底栏为时长 + 粗估 token。
 */
export function buildCompactMappedActionTooltipHtml(
  act: MappedAction & { row: number },
  tooltipMessages: OcMessage[] | undefined,
  formatDurationMs: (ms: number) => string,
): string {
  if (act.actionType === 'UserRequest') {
    const text = act.detail?.trim() || '(empty)'
    return `<div class="action-tip-root action-tip-root--compact"><div class="action-tip-compact-main"><div class="action-tip-compact-head"><strong>${escapeForActionTooltip(
      'user request',
    )}</strong></div><div class="action-tip-compact-lines"><div class="action-tip-compact-line">${escapeForActionTooltip(
      text,
    )}</div></div></div></div>`
  }

  let main = ''
  if (tooltipMessages?.length) {
    const part = resolvePartForAction(tooltipMessages, act)
    if (part) {
      const kv = buildEnglishTooltipContent(part, { allMessages: tooltipMessages })
      const lines = kv.body.flatMap((row) => {
        if (row.kind === 'kv') return [`${row.key}: ${row.value}`]
        if (row.kind === 'error') return [row.value]
        if (row.kind === 'about') return ['About:', ...row.headers]
        return [row.value]
      })
      main = `<div class="action-tip-compact-main"><div class="action-tip-compact-head"><strong>${escapeForActionTooltip(
        kv.primaryLabel,
      )}</strong> <span class="action-tip-compact-status">${escapeForActionTooltip(kv.statusLabel)}</span></div>${
        lines.length
          ? `<div class="action-tip-compact-lines">${lines
              .map((l) => `<div class="action-tip-compact-line">${escapeForActionTooltip(l)}</div>`)
              .join('')}</div>`
          : ''
      }</div>`
    }
  }
  if (!main) {
    const d = act.detail?.trim() ?? ''
    const err = act.errorMessage?.trim() ?? ''
    const snippet = d || err
    const detailLine = snippet
      ? `<div class="action-tip-compact-lines"><div class="action-tip-compact-line">${escapeForActionTooltip(
          snippet.length > 220 ? `${snippet.slice(0, 220)}…` : snippet,
        )}</div></div>`
      : ''
    main = `<div class="action-tip-compact-main"><div class="action-tip-compact-head"><strong>${escapeForActionTooltip(
      act.actionType,
    )}</strong> <span class="action-tip-compact-status">${escapeForActionTooltip(act.status)}</span></div>${detailLine}</div>`
  }
  const dur = formatDurationMs(act.durationMs)
  const tokenSuffix =
    Number.isFinite(act.tokenEstimate) && act.tokenEstimate >= 0
      ? ` · ${Math.round(act.tokenEstimate).toLocaleString('en-US')} tokens`
      : ''
  const foot = `<div class="action-tip-compact-footer">${escapeForActionTooltip(dur)}${tokenSuffix}</div>`
  return `<div class="action-tip-root action-tip-root--compact">${main}${foot}</div>`
}

/** @deprecated 使用 resolvePartForAction + mergeMessagesForActionTooltipLookup */
export function resolvePartForMappedAction(
  messages: OcMessage[],
  messageIndex: number | undefined,
  partIndex: number | undefined
): OcMessagePart | undefined {
  return resolvePartForAction(messages, { partId: undefined, messageIndex, partIndex })
}

export function formatTooltipKeyValuesAsHtml(
  rows: TooltipKeyValue[],
  escapeHtml: (s: string) => string
): string {
  return rows
    .map(
      (r) =>
        `<div class="action-tip-kv"><span class="action-tip-k">${escapeHtml(r.key)}</span><span class="action-tip-v">${escapeHtml(r.value)}</span></div>`
    )
    .join('')
}
