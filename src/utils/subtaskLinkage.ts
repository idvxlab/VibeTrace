import type { OcMessage, OcTodo } from '../types/opencode'
import type { AssistantSubtask } from './subtaskGrouping'

export function normalizeTodoContent(content: string): string {
  return content.trim()
}

/**
 * 子任务选中时：execution 且子任务上已有 **linkedTodoIds** 时，用 Todo 行高亮 + 连到 Todo 面板；否则（planning / wrap_up 或无 id）走消息高亮。
 */
export function subtaskShouldUseTodoLink(st: AssistantSubtask): boolean {
  return st.phase === 'execution' && st.linkedTodoIds.length > 0
}

/** 与右侧子任务、连线绑定的 todo id 集合 */
export function collectTodoLinkIdsForSubtask(st: AssistantSubtask): Set<string> {
  return new Set(st.linkedTodoIds)
}

/**
 * 在子任务中查找与当前待办匹配的段：有 id 时先 **linkedTodoIds**（本段新完成高亮），再 **todos** 快照；
 * 无 id 则按 **content**。从后往前取第一个命中。
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
 * 高亮：本子任务全部 assistant 下标 + 若段首前一条为 user，则带上该 user（本轮提问）。
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
