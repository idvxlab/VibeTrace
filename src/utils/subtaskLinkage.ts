import type { OcMessage, OcTodo } from '../types/opencode'
import type { AssistantSubtask } from './subtaskGrouping'

export function normalizeTodoContent(content: string): string {
  return content.trim()
}

/**
 * When a subtask is selected: execution with **linkedTodoIds** → Todo row highlight + link to Todo panel;
 * otherwise (planning / wrap_up or no id) → message highlight.
 */
export function subtaskShouldUseTodoLink(st: AssistantSubtask): boolean {
  return st.phase === 'execution' && st.linkedTodoIds.length > 0
}

/** Todo id set bound to the right-side subtask and link lines */
export function collectTodoLinkIdsForSubtask(st: AssistantSubtask): Set<string> {
  return new Set(st.linkedTodoIds)
}

/**
 * Find the subtask segment matching the current todo: with id, try **linkedTodoIds** (newly completed in segment) then **todos** snapshot;
 * without id, match by **content**. Scan from end for first hit.
 */
export function findSubtaskIndexForTodo(
  assistantSubtasks: AssistantSubtask[],
  todo: OcTodo
): number | null {
  const id = todo.id?.trim()
  if (id) {
    for (let si = assistantSubtasks.length - 1; si >= 0; si--) {
      const st = assistantSubtasks[si]!
      if (st.linkedTodoIds.includes(id)) return si
      if (st.todos.some(t => t.id?.trim() === id)) return si
    }
  }
  const key = normalizeTodoContent(todo.content)
  if (!key) return null
  for (let si = assistantSubtasks.length - 1; si >= 0; si--) {
    const st = assistantSubtasks[si]!
    if (st.todos.some(t => normalizeTodoContent(t.content) === key)) {
      return si
    }
  }
  return null
}

/**
 * Highlight: all assistant indices in this subtask + if the message before the segment start is user, include it (this turn's prompt).
 */
export function buildMessageHighlightSet(
  subtask: AssistantSubtask,
  messages: OcMessage[]
): Set<number> {
  const s = new Set<number>()
  const idxs = subtask.assistantMessageIndices
  if (idxs.length === 0) return s
  for (const i of idxs) s.add(i)
  const lo = Math.min(...idxs)
  if (lo > 0 && messages[lo - 1]?.info.role === 'user') {
    s.add(lo - 1)
  }
  return s
}
