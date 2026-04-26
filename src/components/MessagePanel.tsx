import { useState, useEffect, type RefObject } from 'react'
import type { OcMessage, OcPendingQuestionRequest, OcTodo } from '../types/opencode'
import type { CanonicalTodo, LatestTodowriteBatchProgress } from '../utils/todoRegistry'
import MessageBubble from './MessageBubble'
import TodoPanel from './TodoPanel'
import MessageInput, { type MessageSendPayload } from './MessageInput'
import QuestionPromptPanel from './QuestionPromptPanel'
import { actionFlowPalette } from '../styles/actionFlowPalette'
import { messagesHaveOpenQuestionWithInput } from '../utils/questionPart'

interface MessagePanelProps {
  messages: OcMessage[]
  latestTodos: CanonicalTodo[]
  archivedTodos: CanonicalTodo[]
  /** 最近一条 todowrite 快照对应的「本批」进度；无快照时 null */
  latestTodowriteBatchProgress: LatestTodowriteBatchProgress | null
  loading: boolean
  /** 已发送用户消息，正在轮询等待助手回复（SSE 可能未及时更新界面） */
  waitingForAssistantReply?: boolean
  sessionId: string
  sessionTitle?: string
  onRefresh: () => void
  onSendMessage: (payload: MessageSendPayload) => Promise<void>
  onAbortMessage?: () => Promise<void>
  aborting?: boolean
  /** 可滚动消息列表容器 ref（供联动连线计算） */
  messageListScrollRef?: RefObject<HTMLDivElement | null>
  /** Todo 列表面板滚动容器（与子任务连线时定位高亮行） */
  todoPanelScrollRef?: RefObject<HTMLDivElement | null>
  /** 与高亮子任务关联的消息下标（planning / wrap_up 等） */
  highlightMessageIndices?: Set<number> | null
  /** 与高亮子任务关联的 todo id（execution 时优先于消息高亮） */
  highlightTodoIds?: Set<string> | null
  /** 选中子任务时递增，驱动待办面板自动展开到对应分区 */
  todoPanelRevealGeneration?: number
  onTodoClick?: (todo: OcTodo) => void
  /** 重命名当前会话标题（PATCH OpenCode） */
  onSessionTitleCommit?: (title: string) => Promise<void>
  /** OpenCode question 工具：待作答请求（来自 SSE question.asked） */
  pendingQuestion?: OcPendingQuestionRequest | null
  onQuestionReply?: (answers: string[][]) => Promise<void>
  onQuestionReject?: () => Promise<void>
  questionSubmitting?: boolean
  /** 当前会话工作区目录（x-opencode-directory），question 内联提交需要 */
  sessionDirectory?: string
  /** 消息内 question 工具提交成功后刷新列表 */
  onQuestionAnswered?: () => Promise<void>
}

export default function MessagePanel({
  messages,
  latestTodos,
  archivedTodos,
  latestTodowriteBatchProgress,
  loading,
  waitingForAssistantReply = false,
  sessionId,
  sessionTitle,
  onSendMessage,
  onAbortMessage,
  aborting,
  messageListScrollRef,
  todoPanelScrollRef,
  highlightMessageIndices,
  highlightTodoIds,
  todoPanelRevealGeneration,
  onTodoClick,
  onSessionTitleCommit,
  pendingQuestion,
  onQuestionReply,
  onQuestionReject,
  questionSubmitting,
  sessionDirectory,
  onQuestionAnswered,
}: MessagePanelProps) {
  const hasInlineQuestion = messagesHaveOpenQuestionWithInput(messages)
  const blockComposerForQuestion =
    hasInlineQuestion ||
    Boolean(pendingQuestion && pendingQuestion.sessionID === sessionId)

  // 获取当前 agent 和模型信息（从最后一条 assistant message）
  const lastAssistantMsg = [...messages].reverse().find(m => m.info.role === 'assistant')
  const agentName = lastAssistantMsg?.info.agent || null
  const modelName = lastAssistantMsg?.info.model?.modelID || null
  const assistantIndices = messages
    .map((m, i) => (m.info.role === 'assistant' ? i : -1))
    .filter((i) => i >= 0)
  const hasRunningTool = messages.some((m, idx) => {
    if (m.info.role !== 'assistant') return false
    const assistantPos = assistantIndices.indexOf(idx)
    const hasLaterAssistant = assistantPos >= 0 && assistantPos < assistantIndices.length - 1
    return m.parts.some((p) => {
      if (p.type !== 'tool') return false
      const s = p.state?.status
      if (s !== 'running' && s !== 'pending') return false
      // 若已进入后续 assistant turn，该 running/pending 视为失效，不再显示终止按钮
      return !hasLaterAssistant
    })
  })

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: '#FFFFFF',
      }}
    >
      {/* Header */}
      <div
        style={{
          height: 48,
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid #E8E8E8',
          background: '#FFFFFF',
          flexShrink: 0,
        }}
      >
        <EditableSessionTitle
          sessionId={sessionId}
          title={sessionTitle}
          loading={loading}
          onCommit={onSessionTitleCommit}
        />
      </div>

      {waitingForAssistantReply && !loading && (
        <div
          style={{
            flexShrink: 0,
            padding: '8px 16px',
            fontSize: 12,
            color: '#4338ca',
            background: 'linear-gradient(90deg, #eef2ff 0%, #faf5ff 100%)',
            borderBottom: '1px solid #c7d2fe',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#6366f1',
              flexShrink: 0,
            }}
          />
          <span style={{ fontWeight: 600 }}>等待模型回复中…</span>
          <span style={{ color: '#64748b', fontWeight: 400 }}>
            已自动轮询刷新；若长时间无内容，请查看 OpenCode 终端日志或模型是否排队。
          </span>
        </div>
      )}

      {/* Messages (scrollable) */}
      <div
        ref={messageListScrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '0',
        }}
      >
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '32px', color: '#888', fontSize: 12 }}>
            加载中...
          </div>
        ) : messages.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888', fontSize: 12 }}>
            选择一个 Session 开始对话
          </div>
        ) : (
          messages.map((msg, idx) => {
            const hl = highlightMessageIndices?.has(idx) ?? false
            return (
              <div
                key={msg.info.id || `msg-${idx}`}
                data-message-index={idx}
                style={{
                  borderRadius: 10,
                  padding: hl ? '6px 8px' : '2px 0',
                  margin: hl ? '2px -4px' : 0,
                  outline: hl ? `2px solid ${actionFlowPalette.completed.stroke}` : 'none',
                  outlineOffset: hl ? 1 : 0,
                  background: hl ? 'rgba(245, 255, 234, 0.55)' : 'transparent',
                  boxShadow: hl ? `0 0 0 1px rgba(145, 163, 123, 0.25)` : 'none',
                  transition: 'background 0.15s ease, outline 0.15s ease',
                }}
              >
                <MessageBubble
                  message={msg}
                  isLastInTurn={isLastMessageInTurn(messages, idx)}
                  sessionDirectory={sessionDirectory}
                  ssePendingQuestion={
                    pendingQuestion && pendingQuestion.sessionID === sessionId ? pendingQuestion : null
                  }
                  onQuestionAnswered={onQuestionAnswered}
                />
              </div>
            )
          })
        )}
      </div>

      {/* Todo Panel：历次快照 + 当前 API 兜底 */}
      {(latestTodos.length > 0 || archivedTodos.length > 0) && (
        <div style={{ flexShrink: 0 }}>
          <TodoPanel
            latestActive={latestTodos}
            archivedCompleted={archivedTodos}
            latestTodowriteBatchProgress={latestTodowriteBatchProgress}
            highlightTodoIds={highlightTodoIds}
            todoPanelRevealGeneration={todoPanelRevealGeneration}
            onTodoClick={onTodoClick}
            listScrollRef={todoPanelScrollRef}
          />
        </div>
      )}

      {pendingQuestion &&
        pendingQuestion.sessionID === sessionId &&
        onQuestionReply &&
        !hasInlineQuestion && (
        <QuestionPromptPanel
          request={pendingQuestion}
          disabled={loading}
          submitting={questionSubmitting}
          onReply={onQuestionReply}
          onReject={onQuestionReject}
        />
      )}

      {/* Message Input (直接贴着 todo 或消息) */}
      <div style={{ flexShrink: 0 }}>
        <MessageInput
          onSend={onSendMessage}
          disabled={!sessionId || loading || questionSubmitting || blockComposerForQuestion}
          onAbort={onAbortMessage}
          isRunning={hasRunningTool}
          aborting={aborting}
          sessionId={sessionId}
          agentName={agentName}
          modelName={modelName}
        />
      </div>
    </div>
  )
}

function EditableSessionTitle({
  sessionId,
  title,
  loading,
  onCommit,
}: {
  sessionId: string
  title?: string
  loading: boolean
  onCommit?: (next: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title ?? '')
  const [saving, setSaving] = useState(false)

  const canEdit = Boolean(sessionId && onCommit && !loading)

  useEffect(() => {
    if (!editing) setDraft(title ?? '')
  }, [title, editing])

  const display = title?.trim() ? title : '未命名 Session'

  const startEdit = () => {
    if (!canEdit) return
    setDraft(title ?? '')
    setEditing(true)
  }

  const cancel = () => {
    setDraft(title ?? '')
    setEditing(false)
  }

  const commit = async () => {
    if (!onCommit) return
    const next = draft.trim()
    if (!next) {
      cancel()
      return
    }
    if (next === (title ?? '').trim()) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await onCommit(next)
      setEditing(false)
    } catch (e) {
      console.error('[EditableSessionTitle]', e)
    } finally {
      setSaving(false)
    }
  }

  if (!canEdit) {
    return (
      <span style={{ fontSize: 13, fontWeight: 500, color: '#171717' }}>{display}</span>
    )
  }

  if (editing) {
    return (
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
        autoFocus
        disabled={saving}
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: '#171717',
          border: '1px solid #8445BC',
          borderRadius: 6,
          padding: '4px 8px',
          minWidth: 200,
          maxWidth: 'min(480px, 70vw)',
          outline: 'none',
          fontFamily: 'inherit',
        }}
      />
    )
  }

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={startEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          startEdit()
        }
      }}
      style={{
        fontSize: 13,
        fontWeight: 500,
        color: '#171717',
        cursor: 'pointer',
      }}
      title="点击修改标题"
    >
      {display}
    </span>
  )
}

function isLastMessageInTurn(messages: OcMessage[], idx: number): boolean {
  const current = messages[idx]
  if (current.info.role === 'user') {
    return false
  }
  const next = messages[idx + 1]
  return !next || next.info.role === 'user'
}
