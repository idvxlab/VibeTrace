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

/** True when this assistant row includes step-finish with reason === stop (Agent ended this step). */
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

/** Todo list resolution order for one todowrite tool part: input.todos → metadata.todos → output JSON */
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

/** Parse first todowrite todos from an assistant message */
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

/** Prefer id, else normalized content string, for aligning snapshots across time */
export function todoMatchKey(t: OcTodo): string {
  if (t.id?.trim()) return `id:${t.id.trim()}`
  return `c:${t.content.trim()}`
}

/**
 * Items whose same todo key (prefer id) moved **non-completed → completed** vs the previous snapshot.
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
 * Todo ids newly completed in **this segment** only — Todo panel highlights these rows instead of every item in the snapshot.
 */
function linkedTodoIdsForHighlight(newly: OcTodo[]): string[] {
  const s = new Set<string>()
  for (const t of newly) {
    if (t.id?.trim()) s.add(t.id.trim())
  }
  return [...s]
}

/** Non-empty list and every item is completed */
function allTodosCompleted(s: OcTodo[]): boolean {
  return s.length > 0 && s.every(t => t.status === 'completed')
}

/**
 * - **planning**: no list yet → first list write; or prior snapshot all done → next todowrite (**includes** that message).
 * - **execution**: previous todowrite snapshot still has pending work → pure assistant up to the next todowrite (**excludes** both todowrite rows).
 * - **wrap_up**: last todowrite snapshot is all completed, yet more assistant output follows (closing reply).
 */
export type SubtaskPhase = 'planning' | 'execution' | 'wrap_up'

export interface AssistantSubtask {
  subtask_id: string
  phase: SubtaskPhase
  /** Segment-end todo list by phase: planning = trailing todowrite snapshot; execution = following todowrite; wrap_up = fallback */
  todos: OcTodo[]
  todosNewlyCompleted: OcTodo[]
  /**
   * Todo ids completed **inside this segment** (matches `todosNewlyCompleted`, not the full `todos` list).
   * Drives per-row highlights in the Todo panel; when empty, execution falls back to message highlighting.
   */
  linkedTodoIds: string[]
  /** User message indices at this subtask start — used to render UserRequest actions. */
  userMessageIndices: number[]
  assistantMessageIndices: number[]
}

/**
 * Subtask id stays stable as more assistant turns append (keyed by the first assistant message id in the segment)
 * so we do not treat continuations as brand-new subtasks. User messages only open a new range; inside the range
 * segmentation is still driven by todowrite completion diffs.
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
 * Split assistant indices by user turns: a user ends the prior segment and seeds the next UserRequest action.
 * Todo snapshot completion rules still refine segments inside each range.
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
    /** Canonical todo list assigned at each message index — wins over raw tool parsing */
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
     * Subtask splits: completion-driven within a user-scoped assistant range.
     * - After the first todowrite we enter execution and keep accumulating.
     * - pending → in_progress does **not** cut a new segment.
     * - Only when a todowrite snapshot diff shows newly completed items do we close the segment at that tw row.
     * - The next segment starts at the following assistant index (extra user rows inside the range do not change this rule).
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
