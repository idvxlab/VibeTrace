import type { OcMessage, OcMessagePart, OcSession, ToolPart } from '../types/opencode'
import type { TraceAction, TraceTokenBreakdown, TurnTrace } from '../types/trace'
import { stripHarnessGuidanceForDisplay } from '../config/harnessGuidance'
import { buildMappedActionsFromMessages } from './actionMapping'
import { groupAssistantSubtasks } from './subtaskGrouping'
import { buildSubtaskCardMetrics } from './subtaskMetrics'

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function nestedMessageRecord(message: OcMessage): Record<string, unknown> | null {
  return asRecord(asRecord(message)?.message)
}

export function getMessageFinish(message: OcMessage): string | undefined {
  const direct = asRecord(message)
  const nested = nestedMessageRecord(message)
  const candidates = [
    message.info.finish,
    typeof nested?.finish === 'string' ? nested.finish : undefined,
    typeof direct?.finish === 'string' ? direct.finish : undefined,
  ]
  return candidates.find((x): x is string => Boolean(x))
}

function partIsStop(part: OcMessagePart): boolean {
  return part.type === 'step-finish' && part.reason === 'stop'
}

export function isAssistantStopMessage(message: OcMessage): boolean {
  if (message.info.role !== 'assistant') return false
  if (getMessageFinish(message) === 'stop') return true
  return message.parts.some(partIsStop)
}

export function findLatestAssistantStopMessage(messages: OcMessage[]): OcMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg && isAssistantStopMessage(msg)) return msg
  }
  return null
}

function textFromUserMessage(message: OcMessage): string {
  const partText = message.parts
    .filter((part): part is Extract<OcMessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n\n')
  return stripHarnessGuidanceForDisplay(partText || message.info.content || '').trim()
}

function traceTokensFromMessages(messages: OcMessage[]): TraceTokenBreakdown {
  const out: TraceTokenBreakdown = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  }
  for (const msg of messages) {
    if (msg.info.role !== 'assistant') continue
    const t = msg.info.tokens
    if (!t) continue
    out.input += t.input ?? 0
    out.output += t.output ?? 0
    out.reasoning += t.reasoning ?? 0
    out.cacheRead += t.cache?.read ?? 0
    out.cacheWrite += t.cache?.write ?? 0
  }
  out.total = out.input + out.output + out.reasoning + out.cacheRead + out.cacheWrite
  return out
}

function costFromMessages(messages: OcMessage[]): number {
  let cost = 0
  for (const msg of messages) {
    const c = msg.info.cost
    if (typeof c === 'number' && Number.isFinite(c)) cost += c
  }
  return cost
}

function findPartByAction(segmentMessages: OcMessage[], action: { partIndex?: number; messageIndex?: number }): OcMessagePart | null {
  if (action.messageIndex === undefined || action.partIndex === undefined) return null
  const msg = segmentMessages[action.messageIndex]
  return msg?.parts[action.partIndex] ?? null
}

function rawPartPayload(part: OcMessagePart | null): Pick<TraceAction, 'tool' | 'input' | 'output' | 'error'> {
  if (!part) {
    return { input: null, output: null, error: null }
  }
  if (part.type === 'tool') {
    const toolPart = part as ToolPart
    return {
      tool: toolPart.tool,
      input: toolPart.state?.input ?? null,
      output: toolPart.state?.output ?? null,
      error: toolPart.state?.error ?? null,
    }
  }
  if (part.type === 'text' || part.type === 'reasoning') {
    return {
      input: null,
      output: part.text ?? '',
      error: null,
    }
  }
  return { input: null, output: null, error: null }
}

export function buildTurnTrace(args: {
  messages: OcMessage[]
  endAssistantMessageId: string
  session?: Pick<OcSession, 'id' | 'title' | 'directory'>
  nowMs?: number
}): TurnTrace | null {
  const { messages, endAssistantMessageId, session } = args
  const endIndex = messages.findIndex((m) => m.info.id === endAssistantMessageId)
  if (endIndex < 0) return null
  const endMessage = messages[endIndex]
  if (!endMessage || !isAssistantStopMessage(endMessage)) return null

  let startIndex = -1
  for (let i = endIndex; i >= 0; i--) {
    if (messages[i]?.info.role === 'user') {
      startIndex = i
      break
    }
  }
  if (startIndex < 0) return null

  const turnMessages = messages.slice(startIndex, endIndex + 1)
  const userMessage = turnMessages[0]
  if (!userMessage || userMessage.info.role !== 'user') return null

  const nowMs = args.nowMs ?? Date.now()
  const subtasks = groupAssistantSubtasks(turnMessages)
  const traceSubtasks = subtasks.map((subtask, subtaskIndex) => {
    const indices = [
      ...(subtask.userMessageIndices ?? []),
      ...subtask.assistantMessageIndices,
    ].sort((a, b) => a - b)
    const segmentMessages = indices
      .map((i) => turnMessages[i])
      .filter((msg): msg is OcMessage => Boolean(msg))
    const actions = buildMappedActionsFromMessages(segmentMessages, { nowMs })
    const metrics = buildSubtaskCardMetrics(subtask, turnMessages, subtaskIndex, { nowMs })

    return {
      index: subtaskIndex,
      title: metrics.title,
      phase: subtask.phase,
      todos: subtask.todos,
      metrics: {
        durationMs: metrics.durationMs,
        tokensTotal: metrics.tokensSegmentSum,
        tokenBreakdown: metrics.tokenBreakdown,
        llmCallCount: metrics.llmCallCount,
        cost: metrics.costSegmentSum,
      },
      actions: actions.map((action, actionIndex) => {
        const part = findPartByAction(segmentMessages, action)
        const payload = rawPartPayload(part)
        const isUserRequest = action.actionType === 'UserRequest'
        return {
          index: actionIndex,
          type: action.actionType,
          tool: payload.tool,
          status: action.status,
          durationMs: action.durationMs,
          tokenEstimate: action.tokenEstimate,
          input: isUserRequest ? action.detail ?? '' : payload.input,
          output: isUserRequest ? null : payload.output,
          error: payload.error ?? action.errorMessage ?? null,
        }
      }),
    }
  })

  const created = endMessage.info.time?.created
  const completed = endMessage.info.time?.completed
  const model = endMessage.info.model
  const tokens = traceTokensFromMessages(turnMessages)
  const cost = costFromMessages(turnMessages)

  return {
    schemaVersion: 'trace.v1',
    generatedAt: new Date(nowMs).toISOString(),
    session: {
      id: session?.id ?? endMessage.info.sessionID,
      title: session?.title,
      directory: session?.directory,
    },
    turn: {
      userInput: textFromUserMessage(userMessage),
      startUserMessageId: userMessage.info.id,
      endAssistantMessageId,
      startIndex,
      endIndex,
      finish: getMessageFinish(endMessage) ?? 'stop',
      created,
      completed,
      durationMs:
        typeof created === 'number' && typeof completed === 'number' && completed >= created
          ? completed - created
          : undefined,
      modelID: model?.modelID,
      providerID: model?.providerID,
      tokens,
      cost,
    },
    subtasks: traceSubtasks,
  }
}
