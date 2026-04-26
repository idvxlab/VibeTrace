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
  /** OpenCode 若下发则使用；否则由 cockpit 会话内分配稳定 id */
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
  /** OpenCode 在上下文压缩时写入的部件（见 packages/opencode 消息序列化） */
  | 'compaction'

export interface OcMessageInfo {
  role: 'user' | 'assistant'
  content?: string  // user message 的文本内容
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
    /** OpenCode question 等工具在交互完成前可能为 pending */
    status: 'pending' | 'running' | 'completed' | 'error'
    input?: Record<string, unknown>
    output?: string
    /** 服务端生成的可读标题（如 read 路径、websearch 查询摘要、bash 说明） */
    title?: string
    /** 部分工具（如 task）会把子会话信息放在 metadata（running/completed 都可能出现） */
    metadata?: Record<string, unknown>
    /** 工具失败时的错误（常见形态：`ProviderModelNotFoundError: ...`） */
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

/** Agent 单步结束；reason === 'stop' 表示本步 Agent 主动暂停（一次完整 Agent 输出边界） */
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
  /** 部分版本会带摘要或占位文本 */
  text?: string
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

// ===== 可视化：Agent Action =====

export type ActionType =
  | 'UserRequest'
  | 'Think'
  | 'Clarify'
  | 'Plan'
  | 'Permission'
  | 'Subagent'
  | 'Response'
  | 'Read'
  | 'Write'
  | 'Shell'
  | 'Search'
  | 'Skill'
  | 'Compaction'

export type ActionStatus = 'pending' | 'running' | 'completed' | 'error'

/** 单条可绘制动作（来自 message part 或 SSE 事件） */
export interface MappedAction {
  actionType: ActionType
  status: ActionStatus
  /** 毫秒；无可靠时间戳时可为 0，由 UI 在 duration 模式下用下限代替 */
  durationMs: number
  /** 按字符/4 的粗估 token */
  tokenEstimate: number
  /** 排序与时间轴 */
  sortTime: number
  source: 'part' | 'sse-permission' | 'sse-session' | 'child-session'
  /** 该动作所属会话 id（用于从任意 action 触发 fork） */
  sessionID?: string
  messageID?: string
  callID?: string
  /** task/subagent 工具对应的子会话 id（若可解析） */
  childSessionID?: string
  /** 并行区分键：优先 callID，其次 childSessionID */
  parallelKey?: string
  /** 来自子会话拉取的动作：对应子 session id */
  branchChildSessionID?: string
  /** 父消息里触发 task 的 callID，用于分叉连线对齐 */
  parentTaskCallID?: string
  /** 工具 wall-clock 区间（用于并行重叠判定）；仅 part 工具有值 */
  toolWindow?: { startMs: number; endMs: number }
  /** 同一 message 内时间重叠且 callID 同 stem 的并行组 */
  parallelGroupId?: string
  /** 并行组内 lane（0..n-1），子会话动作继承父 task 的 lane */
  parallelLaneIndex?: number
  partIndex?: number
  messageIndex?: number
  /** 对应 `OcMessagePart.id`，用于在合并后的消息列表中唯一定位 part（避免 messageIndex 与数组不一致） */
  partId?: string
  /**
   * 分叉会话可视化：来自父支子会话快照、且位于切出点之后的「幽灵」动作（已不在新会话上下文中，仅灰色展示）。
   */
  forkGhost?: boolean
  /**
   * Fork 对比单面板：0 共享前缀+锚点，1 父会话锚点后旧轨迹（灰），2 fork 后新轨迹。
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

// ===== Question 工具（SSE `question.asked` / POST `/question/{id}/reply`）=====
// 服务端契约见 OpenCode SDK v2：`QuestionRequest`、`QuestionReplyData`（answers 为按题目顺序的 label 数组）

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

/** `GET /question` 列表中的单条（用于与 tool part 的 messageID/callID 匹配 request id） */
export type OcPendingQuestionItem = {
  id: string
  sessionID: string
  questions: unknown[]
  tool?: { messageID?: string; callID?: string; messageId?: string; callId?: string }
}

/** 待用户作答的一条请求（来自 SSE question.asked） */
export type OcPendingQuestionRequest = {
  id: string
  sessionID: string
  questions: OcQuestionInfo[]
  tool?: { messageID: string; callID: string }
  /** SSE 根字段，回复时必须带 x-opencode-directory */
  directory?: string
}

// ===== D3 Event types =====
export interface FlowEvent {
  type: 'thinking' | 'tool' | 'file-write' | 'bash' | 'error' | 'text' | 'step'
  label: string
  timestamp: number
  duration?: number
  toolName?: string
}

/** 全局/工作区 SSE 中与动作相关、需与 message 合并的事件（OpenCode Bus） */
export interface OcSseActionEvent {
  type: 'permission.asked' | 'session.compacted' | string
  time: number
  sessionID?: string
  raw: unknown
}
