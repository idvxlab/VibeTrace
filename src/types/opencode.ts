// ===== OpenCode API Types =====

export interface OcSession {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  version: string
  summary: {
    additions: number
    deletions: number
    files: number
  }
  time: {
    created: number
    updated: number
  }
  parentID?: string
  permission?: Array<{
    permission: string
    pattern: string
    action: string
  }>
}

export interface OcTodo {
  /** Provided by OpenCode when available; otherwise stable id assigned within the VibeTrace session */
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

export type PartType =
  | 'text'
  | 'reasoning'
  | 'tool'
  | 'step-start'
  | 'step-finish'
  | 'text-file'
  | 'image'
  | 'step-end'
  | 'snapshot'
  /** OpenCode writes this part type during context compaction (see packages/opencode messaging) */
  | 'compaction'

export interface OcMessageInfo {
  role: 'user' | 'assistant'
  content?: string  // plaintext for user rows
  time: {
    created: number
    completed?: number
  }
  agent?: string
  model?: {
    providerID: string
    modelID: string
  }
  mode?: string
  tokens?: {
    total: number
    input: number
    output: number
    reasoning: number
    cache?: { read: number; write: number }
  }
  cost?: number
  finish?: string
  id: string
  sessionID: string
  parentID?: string
}

export type TextPart = {
  type: 'text'
  text: string
  id: string
  sessionID: string
  messageID: string
}

export type ReasoningPart = {
  type: 'reasoning'
  text: string
  metadata?: Record<string, unknown>
  time?: { start: number; end: number }
  id: string
  sessionID: string
  messageID: string
}

export type ToolPart = {
  type: 'tool'
  callID: string
  tool: string
  state: {
    /** question tools may remain pending until the user responds */
    status: 'pending' | 'running' | 'completed' | 'error'
    input?: Record<string, unknown>
    /** Most tools return strings; some tools may return structured JSON */
    output?: string | unknown
    /** Server-generated title (read path, websearch summary, bash description, etc.) */
    title?: string
    /** Some tools (e.g. task) stash child session ids in metadata for running + completed states */
    metadata?: Record<string, unknown>
    /** Tool failure payload (typical pattern: `ProviderModelNotFoundError: ...`) */
    error?: string
    time?: { start?: number; end?: number }
  }
  id: string
  sessionID: string
  messageID: string
}

export type StepStartPart = {
  type: 'step-start'
  id: string
  sessionID: string
  messageID: string
}

/** Marks the end of one agent step; reason === 'stop' means the agent paused after a full output */
export type StepFinishPart = {
  type: 'step-finish'
  reason?: string
  id: string
  sessionID: string
  messageID: string
}

export type StepEndPart = {
  type: 'step-end'
  id: string
  sessionID: string
  messageID: string
}

export type TextFilePart = {
  type: 'text-file'
  path: string
  content: string
  id: string
  sessionID: string
  messageID: string
}

export type ImagePart = {
  type: 'image'
  source: {
    type: string
    media_type: string
    data: string
  }
  id: string
  sessionID: string
  messageID: string
}

export type CompactionPart = {
  type: 'compaction'
  id: string
  sessionID: string
  messageID: string
  /** Optional summary/placeholder on some server builds */
  text?: string
  /** OpenCode SDK: whether compaction was automatic */
  auto?: boolean
  /** OpenCode SDK: context overflow trigger */
  overflow?: boolean
}

/** Live SSE compaction marker merged into action flow when message parts lag */
export type OcSessionCompactionEvent = {
  sessionID: string
  time: number
  status: 'running' | 'completed'
  detail?: string
}

export type OcMessagePart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | StepEndPart
  | TextFilePart
  | ImagePart
  | CompactionPart

// ===== Visualization: Agent Actions =====

export type ActionType =
  | 'UserRequest'
  | 'Think'
  | 'Clarify'
  | 'Plan'
  | 'Permission'
  | 'Subagent'
  | 'Response'
  | 'Read'
  | 'SkillRouter'
  | 'Write'
  | 'Shell'
  | 'Search'
  | 'Skill'
  | 'Compaction'

export type ActionStatus = 'pending' | 'running' | 'completed' | 'error'

/** One drawable action derived from a message part or SSE envelope */
export interface MappedAction {
  actionType: ActionType
  status: ActionStatus
  /** Milliseconds; falls back to UI floor in duration mode when timestamps are missing */
  durationMs: number
  /** Rough token estimate (~chars / 4) */
  tokenEstimate: number
  /** Sort key for the shared timeline */
  sortTime: number
  source: 'part' | 'sse-permission' | 'sse-session' | 'child-session'
  /** Owning session id (fork originates from any action referencing this) */
  sessionID?: string
  messageID?: string
  callID?: string
  /** Child session spawned by task/subagent tools (when parseable) */
  childSessionID?: string
  /** Parallelism key: prefers callID, then childSessionID */
  parallelKey?: string
  /** Child-session rows merged after fetch */
  branchChildSessionID?: string
  /** Parent task invocation id used to align fork connectors */
  parentTaskCallID?: string
  /** Tool wall-clock interval for overlap detection (tool parts only) */
  toolWindow?: { startMs: number; endMs: number }
  /** Parallel siblings inside one assistant message (same call stem + overlapping time) */
  parallelGroupId?: string
  /** Lane inside a parallel group (0..n-1); child-session rows inherit the parent task lane */
  parallelLaneIndex?: number
  partIndex?: number
  /** Index into the **`OcMessage[]` slice** used to build this flow (`segmentMessages` in subtask cards ≠ global sidebar index — use **`messageID`** for linkage). */
  messageIndex?: number
  /** Maps to `OcMessagePart.id` after merges (more stable than array indices alone) */
  partId?: string
  /**
   * Fork visualization: rows sourced from a parent snapshot **after** the fork anchor — gray “ghost” trail no
   * longer present in the forked session timeline.
   */
  forkGhost?: boolean
  /**
   * Fork comparison layering: 0 shared prefix incl. anchor, 1 parent-only ghost tail, 2 forked trajectory.
   */
  forkCompareRow?: 0 | 1 | 2
  detail?: string
  errorName?: string
  errorMessage?: string
}

export interface OcMessage {
  info: OcMessageInfo
  parts: OcMessagePart[]
}

// ===== Question tooling (SSE `question.asked`, POST `/question/{id}/reply`) =====
// Server contract mirrors OpenCode SDK v2 QuestionRequest / QuestionReplyData (answers aligned with prompts)

export type OcQuestionOption = {
  label: string
  description: string
}

export type OcQuestionInfo = {
  question: string
  header: string
  options: OcQuestionOption[]
  multiple?: boolean
  custom?: boolean
}

/** One row from GET /question — used to correlate tool parts via messageID/callID */
export type OcPendingQuestionItem = {
  id: string
  sessionID: string
  questions: unknown[]
  tool?: { messageID?: string; callID?: string; messageId?: string; callId?: string }
}

/** Pending interactive question emitted over SSE (`question.asked`) */
export type OcPendingQuestionRequest = {
  id: string
  sessionID: string
  questions: OcQuestionInfo[]
  tool?: { messageID: string; callID: string }
  /** Copied from SSE root; replies must include x-opencode-directory */
  directory?: string
}

/** Reply values for POST `/permission/{requestID}/reply` */
export type OcPermissionReply = 'once' | 'always' | 'reject'

/**
 * Pending permission request from SSE `permission.asked` (or GET `/permission`).
 * Field names cover both PermissionNext (`permission`/`patterns`) and newer v2 (`action`/`resources`).
 */
export type OcPendingPermissionRequest = {
  id: string
  sessionID: string
  /** Permission kind / action name (e.g. bash, edit, read) */
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
  /** Patterns that would be auto-approved if the user picks "always" */
  always?: string[]
  tool?: { messageID: string; callID: string }
  /** Copied from SSE root; replies must include x-opencode-directory */
  directory?: string
  /** When the ask was observed locally (SSE time or hydrate time) */
  askedAt?: number
}

/** One row from GET `/permission` (or session-scoped permission list) */
export type OcPendingPermissionItem = OcPendingPermissionRequest

/**
 * Permission asks kept for the action-flow trajectory (survive after Allow/Reject).
 * Live dialog still uses `OcPendingPermissionRequest`; this is the durable trail.
 */
export type OcPermissionTraceEvent = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  askedAt: number
  repliedAt?: number
  reply?: OcPermissionReply
  /** pending while dialog open; completed for once/always; error for reject */
  status: ActionStatus
  tool?: { messageID: string; callID: string }
}

// ===== D3 Event types =====
export interface FlowEvent {
  type: 'thinking' | 'tool' | 'file-write' | 'bash' | 'error' | 'text' | 'step'
  label: string
  timestamp: number
  duration?: number
  toolName?: string
}

/** Global/workspace SSE envelopes that should merge with REST message fetches (OpenCode bus) */
export interface OcSseActionEvent {
  type: 'permission.asked' | 'session.compacted' | string
  time: number
  sessionID?: string
  /** Populated for permission.asked so action flow can show a richer detail string */
  permission?: OcPendingPermissionRequest
  /** Populated for session.compacted / session.next.compaction.* */
  compaction?: { status: 'running' | 'completed'; detail?: string }
  raw: unknown
}
