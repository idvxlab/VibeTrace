import type {
  OcMessage,
  OcPendingQuestionItem,
  OcPendingQuestionRequest,
  OcQuestionInfo,
  ToolPart,
} from '../types/opencode'

/** Parse question tool stem and options from tool part state.input (same as GET /message) */
export function parseQuestionInputQuestions(input: Record<string, unknown> | undefined): OcQuestionInfo[] {
  if (!input || !Array.isArray(input.questions)) return []
  return input.questions as OcQuestionInfo[]
}

/** Whether the current session has an open question tool with input.questions (for inline UI, not SSE-only) */
export function messagesHaveOpenQuestionWithInput(messages: OcMessage[]): boolean {
  for (const m of messages) {
    if (m.info.role !== 'assistant') continue
    for (const p of m.parts) {
      if (p.type !== 'tool' || p.tool !== 'question') continue
      const st = p.state?.status
      if (st !== 'running' && st !== 'pending') continue
      if (parseQuestionInputQuestions(p.state?.input).length > 0) return true
    }
  }
  return false
}

function toolPartMatchesPending(
  tool: OcPendingQuestionItem['tool'],
  part: ToolPart,
): boolean {
  if (!tool) return false
  const mid = tool.messageID ?? tool.messageId
  const cid = tool.callID ?? tool.callId
  return mid === part.messageID && cid === part.callID
}

/**
 * Prefer the pending object from global SSE `question.asked` (includes official `id` = request id),
 * aligned with the tool part messageID/callID. More reliable than GET /question alone.
 */
export function findRequestIdFromSsePending(
  pending: OcPendingQuestionRequest | null | undefined,
  part: ToolPart,
): string | undefined {
  if (!pending || pending.sessionID !== part.sessionID) return undefined
  const t = pending.tool
  if (!t) return pending.id
  const mid = t.messageID ?? (t as { messageId?: string }).messageId
  const cid = t.callID ?? (t as { callId?: string }).callId
  if (mid === part.messageID && cid === part.callID) return pending.id
  return undefined
}

/** Match against GET /question list (supports messageId/callId field name variants) */
export function findQuestionRequestIdForToolPart(
  list: OcPendingQuestionItem[],
  part: ToolPart,
): string | undefined {
  const hit = list.find((q) => toolPartMatchesPending(q.tool, part))
  if (hit) return hit.id
  const sameSession = list.filter((q) => q.sessionID === part.sessionID)
  if (sameSession.length === 1) return sameSession[0]!.id
  return undefined
}
