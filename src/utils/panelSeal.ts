import type { OcMessage } from '../types/opencode'
import { messageHasAgentStepFinishStop, type AssistantSubtask } from './subtaskGrouping'

/**
 * Whether this panel's trajectory is sealed enough for Trace summary / error diagnosis.
 * Matches SubtaskCard's golden end-node rules (caller still must ensure no running tools).
 */
export function isSubtaskPanelSealed(subtask: AssistantSubtask, messages: OcMessage[]): boolean {
  const assistantIndices = subtask.assistantMessageIndices
  if (assistantIndices.length === 0) return false
  const lastIdx = assistantIndices[assistantIndices.length - 1]!
  const lastMsg = messages[lastIdx]
  if (!lastMsg || lastMsg.info.role !== 'assistant') return false

  if (messageHasAgentStepFinishStop(lastMsg)) return true
  if (lastMsg.info.finish?.trim().toLowerCase() === 'stop') return true

  const spanEnd = Math.max(lastIdx, ...(subtask.userMessageIndices ?? []))
  for (let i = spanEnd + 1; i < messages.length; i++) {
    if (messages[i]) return true
  }
  return false
}
