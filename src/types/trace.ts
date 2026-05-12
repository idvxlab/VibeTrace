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
  tool?: string
  status: ActionStatus
  durationMs: number
  tokenEstimate: number
  input: unknown
  output: unknown
  error: unknown
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
