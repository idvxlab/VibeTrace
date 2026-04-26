import type { OcMessage, OcMessagePart, OcTodo, ToolPart } from '../types/opencode'

const TODO_WRITE_TOOL_NAMES = new Set([
  'todowrite',
  'todo_write',
  'write_todos',
  'update_todos',
])

export function isTodoWriteTool(toolName: string): boolean {
  const t = toolName.toLowerCase().replace(/-/g, '_')
  if (TODO_WRITE_TOOL_NAMES.has(t)) return true
  if (t.includes('todo_write')) return true
  if (t.endsWith('_todowrite')) return true
  return false
}

export function isTodoWriteMessage(message: OcMessage): boolean {
  if (message.info.role !== 'assistant') return false
  return message.parts.some(p => p.type === 'tool' && isTodoWriteTool(p.tool))
}

function partIsStepFinishStop(part: OcMessagePart): boolean {
  const raw = part as { type?: string; reason?: string }
  if (raw.type !== 'step-finish') return false
  return raw.reason === 'stop'
}

/** 本条 assistant 含 step-finish 且 reason === stop（Agent 本步回复终止） */
export function messageHasAgentStepFinishStop(message: OcMessage): boolean {
  if (message.info.role !== 'assistant') return false
  return message.parts.some(partIsStepFinishStop)
}

function shallowCloneTodo(t: OcTodo): OcTodo {
  return { ...t, ...(t.id ? { id: t.id } : {}) }
}

function normalizeStatus(raw: unknown): OcTodo['status'] {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/\s+/g, '_')
  if (s === 'completed' || s === 'complete') return 'completed'
  if (s === 'in_progress' || s === 'inprogress' || s === 'in-progress') return 'in_progress'
  return 'pending'
}

function normalizePriority(raw: unknown): OcTodo['priority'] {
  const s = String(raw ?? 'medium').toLowerCase()
  if (s === 'high') return 'high'
  if (s === 'low') return 'low'
  return 'medium'
}

function normalizeRawTodoItem(item: unknown): OcTodo | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  const content = o.content
  if (typeof content !== 'string' || !content.trim()) return null
  const idRaw = o.id
  const id = typeof idRaw === 'string' && idRaw.trim() ? idRaw.trim() : undefined
  return {
    content: content.trim(),
    status: normalizeStatus(o.status),
    priority: normalizePriority(o.priority),
    ...(id ? { id } : {}),
  }
}

function normalizeRawTodos(raw: unknown[]): OcTodo[] {
  const out: OcTodo[] = []
  for (const x of raw) {
    const t = normalizeRawTodoItem(x)
    if (t) out.push(t)
  }
  return out
}

function extractTodosArray(raw: unknown): OcTodo[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const list = normalizeRawTodos(raw)
  return list.length > 0 ? list : null
}

type ToolStateWithMeta = ToolPart['state'] & {
  metadata?: { todos?: unknown }
}

/** 从单条 todowrite tool part 取列表：input.todos → metadata.todos → output JSON */
export function parseTodowriteTodosFromToolPart(part: ToolPart): OcTodo[] | null {
  const input = part.state?.input
  const fromInput = extractTodosArray(input?.todos)
  if (fromInput) return fromInput

  const meta = (part.state as ToolStateWithMeta | undefined)?.metadata
  const fromMeta = extractTodosArray(meta?.todos)
  if (fromMeta) return fromMeta

  const out = part.state?.output
  if (typeof out === 'string' && out.trim()) {
    try {
      const j = JSON.parse(out) as unknown
      if (Array.isArray(j)) {
        const list = normalizeRawTodos(j)
        if (list.length > 0) return list
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 从 assistant message 中取第一条 todowrite 的 todos */
export function parseTodowriteTodosFromMessage(message: OcMessage): OcTodo[] | null {
  if (message.info.role !== 'assistant') return null
  for (const p of message.parts) {
    if (p.type !== 'tool') continue
    if (!isTodoWriteTool(p.tool)) continue
    const list = parseTodowriteTodosFromToolPart(p)
    if (list && list.length > 0) return list
  }
  return null
}

/** 优先 id，否则规范化 content，用于快照间对齐 */
export function todoMatchKey(t: OcTodo): string {
  if (t.id?.trim()) return `id:${t.id.trim()}`
  return `c:${t.content.trim()}`
}

/**
 * 相对上一次快照，同一 todo（优先 id）下由 **非 completed → completed** 的项
 */
export function diffTodosNewlyCompleted(prev: OcTodo[] | null, next: OcTodo[]): OcTodo[] {
  if (!prev || prev.length === 0) return []
  const prevByKey = new Map<string, OcTodo>()
  for (const t of prev) {
    prevByKey.set(todoMatchKey(t), t)
  }
  const out: OcTodo[] = []
  for (const n of next) {
    if (n.status !== 'completed') continue
    const p = prevByKey.get(todoMatchKey(n))
    if (p && p.status !== 'completed') {
      out.push(shallowCloneTodo(n))
    }
  }
  return out
}

/**
 * 仅本段 **新变为 completed** 的条目 id，用于 Todo 面板只高亮对应行（不用整段快照里的全部 todo）。
 */
function linkedTodoIdsForHighlight(newly: OcTodo[]): string[] {
  const s = new Set<string>()
  for (const t of newly) {
    if (t.id?.trim()) s.add(t.id.trim())
  }
  return [...s]
}

/** 列表非空且全部 completed */
function allTodosCompleted(s: OcTodo[]): boolean {
  return s.length > 0 && s.every(t => t.status === 'completed')
}

/**
 * - **planning**：尚无列表 → 第一次写出列表；或「快照已全部完成」→ 下一次 todowrite（**含**该条 message）。
 * - **execution**：上一条 todowrite 快照里**仍有未完成**时，到下一次 todowrite 之间的纯 assistant（**不含**两条 todowrite）。
 * - **wrap_up**：最后一条 todowrite 快照已全部完成，且其后仍有 assistant（收尾输出）。
 */
export type SubtaskPhase = 'planning' | 'execution' | 'wrap_up'

export interface AssistantSubtask {
  subtask_id: string
  phase: SubtaskPhase
  /** 本子任务语义上的段末列表（ planning 为段末 todowrite 快照；execution 为后一条 todowrite；wrap_up 为 fallback ） */
  todos: OcTodo[]
  todosNewlyCompleted: OcTodo[]
  /**
   * 本段内 **新完成** 的 todo id（与 `todosNewlyCompleted` 一致，非整份 `todos`）。
   * 用于点亮 Todo 面板中的**具体条目**；为空则 execution 也退回消息高亮。
   */
  linkedTodoIds: string[]
  /** 本子任务起点携带的 user message；用于把用户输入画成 UserRequest action。 */
  userMessageIndices: number[]
  assistantMessageIndices: number[]
}

/**
 * 同一子任务段在 assistant 消息增多时仍保持同一 id（仅用段首 assistant 的 message id），
 * 避免仅因追加回复就换 key / 被误认为新开子任务。user 消息只负责开启新的 range，
 * range 内仍由 todowrite 完成 diff 驱动。
 */
function buildSubtaskId(indices: number[], messages: OcMessage[]): string {
  if (indices.length === 0) return 'subtask-empty'
  const first = indices[0]!
  const last = indices[indices.length - 1]!
  const head = messages[first]!
  if (head.info.id && head.info.id.length > 0) {
    return `subtask-${head.info.id}`
  }
  return `subtask-idx-${first}-${last}`
}

function resolveSnapshotForSegment(
  lastIdx: number,
  messages: OcMessage[],
  lastTodowriteSnapshot: OcTodo[] | null,
  resolver: ((index: number) => OcTodo[] | undefined) | undefined,
  fallback: OcTodo[],
  canonicalAt?: (index: number) => OcTodo[] | undefined
): OcTodo[] {
  const c = canonicalAt?.(lastIdx)
  if (c !== undefined && c.length > 0) {
    return c.map(shallowCloneTodo)
  }
  const lastMsg = messages[lastIdx]!
  const fromTool = parseTodowriteTodosFromMessage(lastMsg)
  if (fromTool && fromTool.length > 0) {
    return fromTool.map(shallowCloneTodo)
  }
  const r = resolver?.(lastIdx)
  if (r !== undefined && r.length > 0) {
    return r.map(shallowCloneTodo)
  }
  if (lastTodowriteSnapshot && lastTodowriteSnapshot.length > 0) {
    return lastTodowriteSnapshot.map(shallowCloneTodo)
  }
  return fallback.map(shallowCloneTodo)
}

/**
 * 按 user message 切出 assistant range：user 结束上一段，并作为下一段的起点 action。
 * range 内仍沿用原有 todo 快照完成关系做细分。
 */
function assistantRangesSplitByUser(
  messages: OcMessage[]
): Array<{ assistantIndices: number[]; userMessageIndices: number[] }> {
  const out: Array<{ assistantIndices: number[]; userMessageIndices: number[] }> = []
  let pendingUsers: number[] = []
  let currentAssistants: number[] = []
  const flush = () => {
    if (currentAssistants.length === 0) return
    out.push({
      assistantIndices: currentAssistants,
      userMessageIndices: pendingUsers,
    })
    currentAssistants = []
    pendingUsers = []
  }
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]!.info.role
    if (role === 'user') {
      flush()
      pendingUsers.push(i)
    } else if (role === 'assistant') {
      currentAssistants.push(i)
    }
  }
  flush()
  return out
}

function collectIndicesInclusive(range: number[], lo: number, hi: number): number[] {
  const out: number[] = []
  for (const idx of range) {
    if (idx >= lo && idx <= hi) out.push(idx)
  }
  return out
}

export function groupAssistantSubtasks(
  messages: OcMessage[],
  options?: {
    todosAfterMessageIndex?: (index: number) => OcTodo[] | undefined
    /** 每条 message 下标上的「已分配 id」的 canonical 列表；优先于原始解析 */
    canonicalTodosAtMessageIndex?: (index: number) => OcTodo[] | undefined
    fallbackSessionTodos?: OcTodo[]
  }
): AssistantSubtask[] {
  const resolver = options?.todosAfterMessageIndex
  const canonicalAt = options?.canonicalTodosAtMessageIndex
  const fallback = (options?.fallbackSessionTodos ?? []).map(shallowCloneTodo)

  const subtasks: AssistantSubtask[] = []

  const ranges = assistantRangesSplitByUser(messages)
  if (ranges.length === 0) return subtasks

  for (const { assistantIndices: range, userMessageIndices } of ranges) {
    const rangeSubtasks: AssistantSubtask[] = []

    const push = (
      indices: number[],
      phase: SubtaskPhase,
      todos: OcTodo[],
      newly: OcTodo[]
    ) => {
      if (indices.length === 0) return
      const td = todos.map(shallowCloneTodo)
      const nw = newly.map(shallowCloneTodo)
      const isFirstSubtaskInRange = rangeSubtasks.length === 0
      rangeSubtasks.push({
        subtask_id: buildSubtaskId(indices, messages),
        phase,
        todos: td,
        todosNewlyCompleted: nw,
        linkedTodoIds: linkedTodoIdsForHighlight(nw),
        userMessageIndices: isFirstSubtaskInRange ? [...userMessageIndices] : [],
        assistantMessageIndices: indices,
      })
    }

    const twIndices: number[] = []
    for (const idx of range) {
      const list = parseTodowriteTodosFromMessage(messages[idx]!)
      if (list && list.length > 0) twIndices.push(idx)
    }

    if (twIndices.length === 0) {
      push([...range], 'planning', fallback, [])
      subtasks.push(...rangeSubtasks)
      continue
    }

    /**
     * 子任务切分：完成驱动 + user 边界；这里仅遍历当前 user range 内的 assistant 下标。
     * - 第一次 todowrite 起进入执行段并持续累计；
     * - pending -> in_progress 不切段；
     * - 仅当 todowrite 快照 diff 出现「新完成」时才在该 tw 处收口一段；
     * - 收口后从下一条 assistant 起累计下一段（中间插入的 user 消息不改变分段逻辑）。
     */
    let lastTodowriteSnapshot: OcTodo[] | null = null
    const snapAtTw = new Map<number, OcTodo[]>()
    for (const idx of twIndices) {
      const snap = resolveSnapshotForSegment(
        idx,
        messages,
        lastTodowriteSnapshot,
        resolver,
        fallback,
        canonicalAt
      )
      snapAtTw.set(idx, snap)
      lastTodowriteSnapshot = snap
    }

    let segmentStart = twIndices[0]!
    const firstAssistant = range[0]!
    if (segmentStart > firstAssistant) {
      const leading = collectIndicesInclusive(range, firstAssistant, segmentStart - 1)
      if (leading.length > 0) {
        push(leading, 'planning', fallback, [])
      }
    }

    for (let k = 1; k < twIndices.length; k++) {
      const prevTw = twIndices[k - 1]!
      const curTw = twIndices[k]!
      const prevSnap = snapAtTw.get(prevTw)!
      const curSnap = snapAtTw.get(curTw)!
      const newly = diffTodosNewlyCompleted(prevSnap, curSnap)
      if (newly.length === 0) continue

      const indices = collectIndicesInclusive(range, segmentStart, curTw)
      push(indices, 'execution', curSnap, newly)
      segmentStart = curTw + 1
    }

    const endOfRange = range[range.length - 1]!
    const trailing = collectIndicesInclusive(range, segmentStart, endOfRange)
    if (trailing.length > 0) {
      const lastTw = twIndices[twIndices.length - 1]!
      const snapLast = snapAtTw.get(lastTw) ?? fallback
      const phase: SubtaskPhase = allTodosCompleted(snapLast) ? 'wrap_up' : 'execution'
      push(trailing, phase, snapLast, [])
    }

    subtasks.push(...rangeSubtasks)
  }

  return subtasks
}

export function getAssistantSubtaskIndexForMessage(
  subtasks: AssistantSubtask[],
  messageIndex: number
): number {
  return subtasks.findIndex(s => s.assistantMessageIndices.includes(messageIndex))
}
