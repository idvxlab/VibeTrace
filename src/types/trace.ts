import type { ActionStatus, ActionType, OcTodo } from './opencode'
import type { SubtaskTokenBreakdown } from '../utils/subtaskMetrics'
import type { SubtaskPhase } from '../utils/subtaskGrouping'

export type TraceTokenBreakdown = SubtaskTokenBreakdown

export interface TraceSessionInfo {
  id: string
  title?: string
  directory?: string
}

export interface TraceTurnInfo {
  userInput: string
  startUserMessageId: string
  endAssistantMessageId: string
  startIndex: number
  endIndex: number
  finish: string
  created?: number
  completed?: number
  durationMs?: number
  modelID?: string
  providerID?: string
  tokens: TraceTokenBreakdown
  cost?: number
}

export interface TraceAction {
  index: number
  type: ActionType
  status: ActionStatus
  durationMs: number
  tokenEstimate: number
  input: unknown
  output: unknown
  error: unknown
  tool?: string
  /** Parent session row vs task/subagent child session */
  source?: 'parent' | 'child-session'
  /** Child session id when `source` is `child-session` */
  childSessionID?: string
  /** Parent task tool `callID` that spawned the child session */
  parentTaskCallID?: string
}

export interface TraceSubtask {
  index: number
  title: string
  phase: SubtaskPhase
  todos: OcTodo[]
  metrics: {
    durationMs: number | null
    tokensTotal: number
    tokenBreakdown: TraceTokenBreakdown
    llmCallCount: number
    cost: number
  }
  actions: TraceAction[]
}

export interface TurnTrace {
  schemaVersion: 'trace.v1'
  generatedAt: string
  session: TraceSessionInfo
  turn: TraceTurnInfo
  subtasks: TraceSubtask[]
}

export interface TraceForkMeta {
  forkAnchorMessageId: string
  forkAnchorPartId?: string
  /** The original session the user was unhappy with and forked away from. */
  sourceParentSessionId: string
  /** The new session created by the fork. */
  forkedSessionId: string
}

/**
 * Comparison data from the source (original) session.
 * Present only when this ingest session was created via a fork.
 * Contains the complete turn where the fork anchor lives, plus up to 3 subsequent turns
 * in the original session — the trajectory the user chose to abandon.
 *
 * The new (forked) session's own trajectory is already in `current_turn` + `history`.
 */
export interface TraceForkComparison {
  meta: TraceForkMeta
  session: TraceSessionInfo
  /**
   * Turns from the source (original) session starting with the anchor turn.
   * Chronological order (oldest first). Max 4 turns: anchor + up to 3 after.
   */
  sourceTurns: TurnTrace[]
}

/** Ingest payload: one triggering turn plus prior session history. */
export interface SessionTraceBundle {
  schemaVersion: 'trace.session.v1'
  generatedAt: string
  session: TraceSessionInfo
  /** The turn that triggered this ingest (assistant stop). */
  current_turn: TurnTrace
  /** Earlier turns in the same session, chronological (oldest first). */
  history: TurnTrace[]
  ingest: {
    turnLimit: number
    primaryEndAssistantMessageId: string
  }
  fork?: TraceForkComparison
}

export type IngestTracePayload = TurnTrace | SessionTraceBundle

export function isSessionTraceBundle(trace: IngestTracePayload): trace is SessionTraceBundle {
  return trace.schemaVersion === 'trace.session.v1'
}

export function primaryTurnFromIngestTrace(trace: IngestTracePayload): TurnTrace {
  if (isSessionTraceBundle(trace)) return trace.current_turn
  return trace
}

/** Chronological order for analyzer prompts (history → current). */
export function chronologicalTurnsFromSessionBundle(trace: SessionTraceBundle): TurnTrace[] {
  return [...trace.history, trace.current_turn]
}

/** Legacy ingest bundles used `turns[]` (newest first). */
export function normalizeSessionTraceBundle(raw: unknown): SessionTraceBundle | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  if (t.schemaVersion !== 'trace.session.v1') return null
  if (t.current_turn && typeof t.current_turn === 'object') {
    return t as SessionTraceBundle
  }
  const turns = t.turns
  if (!Array.isArray(turns) || turns.length === 0) return null
  const newestFirst = turns.filter((x): x is TurnTrace => Boolean(x && typeof x === 'object'))
  if (newestFirst.length === 0) return null
  const [current_turn, ...rest] = newestFirst
  return {
    ...(t as SessionTraceBundle),
    current_turn: current_turn!,
    history: [...rest].reverse(),
  }
}
