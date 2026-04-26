import type {
  OcMessage,
  OcPendingQuestionItem,
  OcPendingQuestionRequest,
  OcQuestionInfo,
  ToolPart,
} from '../types/opencode'

/** 从 tool part 的 state.input 解析 question 工具的题干与选项（与 GET /message 一致） */
export function parseQuestionInputQuestions(input: Record<string, unknown> | undefined): OcQuestionInfo[] {
  if (!input || !Array.isArray(input.questions)) return []
  return input.questions as OcQuestionInfo[]
}

/** 当前会话消息里是否存在「待作答」且已带 input.questions 的 question 工具（用于内联 UI，避免只依赖 SSE） */
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
 * 优先使用全局 SSE `question.asked` 写入的待答对象（含官方 `id` = request id），
 * 与当前 tool part 的 messageID/callID 对齐。比单独依赖 GET /question 更可靠。
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

/** 供与 GET /question 列表匹配（兼容 messageId/callId 等字段名） */
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
