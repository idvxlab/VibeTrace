import type { MappedAction, OcMessage, OcMessagePart, OcSession, ToolPart } from '../types/opencode'
import { traceSessionTurnLimit } from '../config/traceIngest'
import type {
  SessionTraceBundle,
  TraceAction,
  TraceSubtask,
  TraceTokenBreakdown,
  TurnTrace,
} from '../types/trace'
import { stripHarnessGuidanceForDisplay } from '../config/harnessGuidance'
import { getMessages } from '../services/opencodeApi'
import {
  applyParallelLayoutFromCalls,
  buildChildSessionBandMap,
  buildChildSessionBranchActions,
  buildMappedActionsFromMessages,
  collectTaskChildDescriptors,
  detectParallelCallMapping,
  type TaskChildDescriptor,
} from './actionMapping'
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

/** Completed turn end ids in chronological order (oldest → newest). */
export function findAssistantStopTurnEndIds(messages: OcMessage[]): string[] {
  const ids: string[] = []
  for (const msg of messages) {
    if (isAssistantStopMessage(msg)) ids.push(msg.info.id)
  }
  return ids
}

/** Message slice for one turn (user through assistant stop), or null if invalid. */
export function sliceMessagesForTurn(
  messages: OcMessage[],
  endAssistantMessageId: string,
): OcMessage[] | null {
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
  return messages.slice(startIndex, endIndex + 1)
}

/**
 * Turn end ids to include in ingest: newest first, capped at `maxTurns`, always includes `primaryEndId`.
 */
export function selectTurnEndIdsForSessionIngest(
  messages: OcMessage[],
  primaryEndAssistantMessageId: string,
  maxTurns: number,
): string[] {
  const chronological = findAssistantStopTurnEndIds(messages)
  const primaryIdx = chronological.indexOf(primaryEndAssistantMessageId)
  if (primaryIdx < 0) return []
  const limit = Math.max(1, maxTurns)
  const windowStart = Math.max(0, primaryIdx - limit + 1)
  return chronological.slice(windowStart, primaryIdx + 1).reverse()
}

function mergeChildMessageMaps(
  ...maps: Record<string, OcMessage[]>[]
): Record<string, OcMessage[]> {
  const out: Record<string, OcMessage[]> = {}
  for (const m of maps) {
    for (const [sid, msgs] of Object.entries(m)) {
      if (!msgs.length) continue
      const prev = out[sid]
      if (!prev?.length) out[sid] = msgs
    }
  }
  return out
}

/** Public alias for use in fork-ingest utilities. */
export const mergeChildMessageMapsPublic = mergeChildMessageMaps

/** Auto-ingest only if the assistant stop finished within this window (2 minutes). */
export const TRACE_INGEST_FRESH_WINDOW_MS = 2 * 60_000

/** Normalize OpenCode timestamps (seconds or ms) to epoch ms. */
export function normalizeEpochMs(value: number): number {
  if (!Number.isFinite(value)) return value
  if (value < 1e11) return value * 1000
  if (value > 1e14) return Math.floor(value / 1000)
  return value
}

function readCompletedMs(message: OcMessage): number | null {
  const completed = message.info.time?.completed
  if (typeof completed === 'number' && Number.isFinite(completed)) {
    return normalizeEpochMs(completed)
  }
  const nested = nestedMessageRecord(message)
  const nestedTime = nested ? asRecord(nested.time) : null
  const nestedCompleted = nestedTime?.completed
  if (typeof nestedCompleted === 'number' && Number.isFinite(nestedCompleted)) {
    return normalizeEpochMs(nestedCompleted)
  }
  return null
}

/**
 * Whether this stop is recent enough to auto-ingest.
 * Uses completion time when present; if stop is visible but `completed` is not set yet (SSE lag), treat as fresh.
 */
export function isAssistantStopWithinIngestWindow(
  message: OcMessage,
  nowMs: number = Date.now(),
  windowMs: number = TRACE_INGEST_FRESH_WINDOW_MS,
): boolean {
  const completedMs = readCompletedMs(message)
  if (completedMs != null) {
    return nowMs - completedMs <= windowMs
  }
  if (isAssistantStopMessage(message)) {
    return true
  }
  return false
}

/** For debug logs — when the stop finished (ms), if known. */
export function getAssistantStopCompletedMs(message: OcMessage): number | null {
  return readCompletedMs(message)
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

function mergeTokenBreakdown(a: TraceTokenBreakdown, b: TraceTokenBreakdown): TraceTokenBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  }
}

function costFromMessages(messages: OcMessage[]): number {
  let cost = 0
  for (const msg of messages) {
    const c = msg.info.cost
    if (typeof c === 'number' && Number.isFinite(c)) cost += c
  }
  return cost
}

function findPartForMappedAction(
  action: MappedAction,
  segmentMessages: OcMessage[],
  childMessagesBySessionId: Record<string, OcMessage[]>,
): OcMessagePart | null {
  if (action.messageIndex === undefined || action.partIndex === undefined) return null
  if (action.source === 'child-session' && action.branchChildSessionID) {
    const childMsgs = childMessagesBySessionId[action.branchChildSessionID]
    return childMsgs?.[action.messageIndex]?.parts[action.partIndex] ?? null
  }
  return segmentMessages[action.messageIndex]?.parts[action.partIndex] ?? null
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

function mappedActionToTraceAction(
  action: MappedAction,
  actionIndex: number,
  segmentMessages: OcMessage[],
  childMessagesBySessionId: Record<string, OcMessage[]>,
): TraceAction {
  const part = findPartForMappedAction(action, segmentMessages, childMessagesBySessionId)
  const payload = rawPartPayload(part)
  const isUserRequest = action.actionType === 'UserRequest'
  const traceAction: TraceAction = {
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
  if (action.source === 'child-session') {
    traceAction.source = 'child-session'
    traceAction.childSessionID = action.branchChildSessionID ?? action.childSessionID
    traceAction.parentTaskCallID = action.parentTaskCallID
  } else {
    traceAction.source = 'parent'
  }
  return traceAction
}

function childMessagesForDescriptors(
  descriptors: TaskChildDescriptor[],
  childMessagesBySessionId: Record<string, OcMessage[]>,
): OcMessage[] {
  const seen = new Set<string>()
  const out: OcMessage[] = []
  for (const d of descriptors) {
    if (seen.has(d.childSessionID)) continue
    seen.add(d.childSessionID)
    const msgs = childMessagesBySessionId[d.childSessionID]
    if (msgs?.length) out.push(...msgs)
  }
  return out
}

/** Task descriptors in segment plus nested tasks inside already-fetched child sessions. */
function collectTaskDescriptorsWithNestedChildren(
  segmentMessages: OcMessage[],
  childMessagesBySessionId: Record<string, OcMessage[]>,
): TaskChildDescriptor[] {
  const out: TaskChildDescriptor[] = []
  const seen = new Set<string>()
  const visit = (msgs: OcMessage[]) => {
    for (const d of collectTaskChildDescriptors(msgs)) {
      const key = `${d.callID}__${d.childSessionID}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(d)
      const childMsgs = childMessagesBySessionId[d.childSessionID]
      if (childMsgs?.length) visit(childMsgs)
    }
  }
  visit(segmentMessages)
  return out
}

function buildMergedSubtaskActions(
  segmentMessages: OcMessage[],
  childMessagesBySessionId: Record<string, OcMessage[]>,
  nowMs: number,
): TraceAction[] {
  const parentActions = buildMappedActionsFromMessages(segmentMessages, { nowMs })
  const taskDescriptors = collectTaskDescriptorsWithNestedChildren(segmentMessages, childMessagesBySessionId)
  if (taskDescriptors.length === 0) {
    return parentActions.map((action, i) =>
      mappedActionToTraceAction(action, i, segmentMessages, childMessagesBySessionId),
    )
  }

  const parallelByCallId = detectParallelCallMapping(segmentMessages, nowMs)
  const childSessionBandMap = buildChildSessionBandMap(taskDescriptors, parallelByCallId)
  const childBranchActions: (MappedAction & { row: number })[] = []

  for (const d of taskDescriptors) {
    const childMsgs = childMessagesBySessionId[d.childSessionID]
    if (!childMsgs?.length) continue
    childBranchActions.push(
      ...buildChildSessionBranchActions(childMsgs, {
        branchChildSessionID: d.childSessionID,
        parentTaskCallID: d.callID,
        anchorSortTime: d.anchorSortTime,
        sessionBandIndex: childSessionBandMap.get(d.childSessionID) ?? 1,
        nowMs,
      }),
    )
  }

  const merged = [...parentActions, ...childBranchActions].sort((a, b) => a.sortTime - b.sortTime)
  const flowActions = applyParallelLayoutFromCalls(merged, parallelByCallId)
  return flowActions.map((action, i) =>
    mappedActionToTraceAction(action, i, segmentMessages, childMessagesBySessionId),
  )
}

function subtaskTraceMetrics(
  cardMetrics: ReturnType<typeof buildSubtaskCardMetrics>,
  segmentChildMessages: OcMessage[],
): TraceSubtask['metrics'] {
  if (segmentChildMessages.length === 0) {
    return {
      durationMs: cardMetrics.durationMs,
      tokensTotal: cardMetrics.tokensSegmentSum,
      tokenBreakdown: cardMetrics.tokenBreakdown,
      llmCallCount: cardMetrics.llmCallCount,
      cost: cardMetrics.costSegmentSum,
    }
  }
  const childBd = traceTokensFromMessages(segmentChildMessages)
  const tokenBreakdown = mergeTokenBreakdown(cardMetrics.tokenBreakdown, childBd)
  const childLlm = segmentChildMessages.filter((m) => m.info.role === 'assistant').length
  return {
    durationMs: cardMetrics.durationMs,
    tokensTotal: tokenBreakdown.total,
    tokenBreakdown,
    llmCallCount: cardMetrics.llmCallCount + childLlm,
    cost: cardMetrics.costSegmentSum + costFromMessages(segmentChildMessages),
  }
}

const TRACE_CHILD_SESSION_MAX_DEPTH = 8

/** Fetch task/subagent child sessions for a turn (BFS, includes nested sub-sessions). */
export async function fetchChildMessagesForTurn(
  turnMessages: OcMessage[],
  sessionDirectory: string | undefined,
  maxDepth: number = TRACE_CHILD_SESSION_MAX_DEPTH,
): Promise<Record<string, OcMessage[]>> {
  const result: Record<string, OcMessage[]> = {}
  const seen = new Set<string>()
  let frontier = collectTaskChildDescriptors(turnMessages).map((d) => d.childSessionID)
  let depth = 0

  while (frontier.length > 0 && depth < maxDepth) {
    const batch = [...new Set(frontier)].filter((sid) => !seen.has(sid))
    frontier = []
    if (batch.length === 0) break

    await Promise.all(
      batch.map(async (childSessionID) => {
        seen.add(childSessionID)
        try {
          const msgs = await getMessages(
            childSessionID,
            `trace child session · ${childSessionID.slice(0, 12)}`,
            sessionDirectory,
          )
          result[childSessionID] = msgs
          for (const nested of collectTaskChildDescriptors(msgs)) {
            if (!seen.has(nested.childSessionID)) frontier.push(nested.childSessionID)
          }
        } catch {
          result[childSessionID] = []
        }
      }),
    )
    depth++
  }

  return result
}

export function buildTurnTrace(args: {
  messages: OcMessage[]
  endAssistantMessageId: string
  session?: Pick<OcSession, 'id' | 'title' | 'directory'>
  nowMs?: number
  /** Pre-fetched child session messages keyed by session id (from task/subagent tools). */
  childMessagesBySessionId?: Record<string, OcMessage[]>
}): TurnTrace | null {
  const { messages, endAssistantMessageId, session } = args
  const childMessagesBySessionId = args.childMessagesBySessionId ?? {}
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
    const taskDescriptors = collectTaskDescriptorsWithNestedChildren(segmentMessages, childMessagesBySessionId)
    const segmentChildMessages = childMessagesForDescriptors(taskDescriptors, childMessagesBySessionId)
    const cardMetrics = buildSubtaskCardMetrics(subtask, turnMessages, subtaskIndex, {
      nowMs,
      additionalMessages: segmentChildMessages,
    })
    const traceMetrics = subtaskTraceMetrics(cardMetrics, segmentChildMessages)

    return {
      index: subtaskIndex,
      title: cardMetrics.title,
      phase: subtask.phase,
      todos: subtask.todos,
      metrics: traceMetrics,
      actions: buildMergedSubtaskActions(segmentMessages, childMessagesBySessionId, nowMs),
    }
  })

  const allChildMessages = Object.values(childMessagesBySessionId).flat()
  const metricsMessages = allChildMessages.length ? [...turnMessages, ...allChildMessages] : turnMessages

  const created = endMessage.info.time?.created
  const completed = endMessage.info.time?.completed
  const model = endMessage.info.model
  const tokens = traceTokensFromMessages(metricsMessages)
  const cost = costFromMessages(metricsMessages)

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

/** Build turn trace including task/subagent child session messages (async fetch). */
export async function buildTurnTraceAsync(args: {
  messages: OcMessage[]
  endAssistantMessageId: string
  session?: Pick<OcSession, 'id' | 'title' | 'directory'>
  sessionDirectory?: string
  nowMs?: number
}): Promise<TurnTrace | null> {
  const endIndex = args.messages.findIndex((m) => m.info.id === args.endAssistantMessageId)
  if (endIndex < 0) return null

  let startIndex = -1
  for (let i = endIndex; i >= 0; i--) {
    if (args.messages[i]?.info.role === 'user') {
      startIndex = i
      break
    }
  }
  if (startIndex < 0) return null

  const turnMessages = args.messages.slice(startIndex, endIndex + 1)
  const childMessagesBySessionId = await fetchChildMessagesForTurn(
    turnMessages,
    args.sessionDirectory ?? args.session?.directory,
  )

  return buildTurnTrace({
    messages: args.messages,
    endAssistantMessageId: args.endAssistantMessageId,
    session: args.session,
    nowMs: args.nowMs,
    childMessagesBySessionId,
  })
}

/** Split at fork anchor (inclusive before, exclusive after). */
export function splitMessagesAtForkAnchor(
  messages: OcMessage[],
  forkAnchorMessageId: string,
): { beforeMessages: OcMessage[]; afterMessages: OcMessage[] } | null {
  const anchorIdx = messages.findIndex((m) => m.info.id === forkAnchorMessageId)
  if (anchorIdx < 0) return null
  return {
    beforeMessages: messages.slice(0, anchorIdx + 1),
    afterMessages: messages.slice(anchorIdx + 1),
  }
}

export function findLatestAssistantStopInMessages(messages: OcMessage[]): OcMessage | null {
  return findLatestAssistantStopMessage(messages)
}

/**
 * Find turn-end (assistant stop) message IDs starting from the turn that contains `anchorMessageId`.
 * Returns chronological IDs: [anchorTurnEnd, ...next N stops].
 * Used to collect the parent session's trajectory from the fork point onward.
 */
export function findTurnEndsFromAnchor(
  messages: OcMessage[],
  anchorMessageId: string,
  maxSubsequentTurns = 3,
): string[] {
  const anchorIdx = messages.findIndex((m) => m.info.id === anchorMessageId)
  if (anchorIdx < 0) return []

  const allStopIds = findAssistantStopTurnEndIds(messages)
  const result: string[] = []

  for (const stopId of allStopIds) {
    const stopIdx = messages.findIndex((m) => m.info.id === stopId)
    // The turn that "contains" the anchor = the turn whose stop comes at or after the anchor
    if (stopIdx >= anchorIdx) {
      result.push(stopId)
      if (result.length >= 1 + maxSubsequentTurns) break
    }
  }

  return result
}

/** Build `trace.v1` turns for a message window; `turns[0]` = primary (newest). */
export async function buildTurnsForMessageWindowAsync(args: {
  messages: OcMessage[]
  primaryEndAssistantMessageId: string
  session?: Pick<OcSession, 'id' | 'title' | 'directory'>
  sessionDirectory?: string
  maxTurns?: number
  nowMs?: number
}): Promise<TurnTrace[]> {
  const nowMs = args.nowMs ?? Date.now()
  const maxTurns = args.maxTurns ?? traceSessionTurnLimit()
  const sessionDirectory = args.sessionDirectory ?? args.session?.directory
  const endIds = selectTurnEndIdsForSessionIngest(
    args.messages,
    args.primaryEndAssistantMessageId,
    maxTurns,
  )
  if (endIds.length === 0) return []

  const childMaps = await Promise.all(
    endIds.map(async (endId) => {
      const slice = sliceMessagesForTurn(args.messages, endId)
      if (!slice?.length) return {}
      return fetchChildMessagesForTurn(slice, sessionDirectory)
    }),
  )
  const childMessagesBySessionId = mergeChildMessageMaps(...childMaps)

  const turns: TurnTrace[] = []
  for (const endId of endIds) {
    const turn = buildTurnTrace({
      messages: args.messages,
      endAssistantMessageId: endId,
      session: args.session,
      nowMs,
      childMessagesBySessionId,
    })
    if (turn) turns.push(turn)
  }
  return turns
}

export function splitNewestFirstTurns(newestFirst: TurnTrace[]): {
  current_turn: TurnTrace
  history: TurnTrace[]
} | null {
  if (newestFirst.length === 0) return null
  const [current_turn, ...olderNewestFirst] = newestFirst
  if (!current_turn) return null
  return { current_turn, history: [...olderNewestFirst].reverse() }
}

/** Build session ingest bundle with explicit `current_turn` + chronological `history`. */
export async function buildSessionTraceAsync(args: {
  messages: OcMessage[]
  primaryEndAssistantMessageId: string
  session?: Pick<OcSession, 'id' | 'title' | 'directory'>
  sessionDirectory?: string
  maxTurns?: number
  nowMs?: number
}): Promise<SessionTraceBundle | null> {
  const nowMs = args.nowMs ?? Date.now()
  const maxTurns = args.maxTurns ?? traceSessionTurnLimit()
  const newestFirst = await buildTurnsForMessageWindowAsync(args)
  const split = splitNewestFirstTurns(newestFirst)
  if (!split) return null

  return {
    schemaVersion: 'trace.session.v1',
    generatedAt: new Date(nowMs).toISOString(),
    session: split.current_turn.session,
    current_turn: split.current_turn,
    history: split.history,
    ingest: {
      turnLimit: maxTurns,
      primaryEndAssistantMessageId: args.primaryEndAssistantMessageId,
    },
  }
}
