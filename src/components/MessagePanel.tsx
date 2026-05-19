import { useState, useEffect, useMemo, type RefObject } from 'react'
import type { OcMessage, OcPendingQuestionRequest, OcTodo } from '../types/opencode'
import type { CanonicalTodo, LatestTodowriteBatchProgress } from '../utils/todoRegistry'
import MessageBubble from './MessageBubble'
import TodoPanel from './TodoPanel'
import MessageInput, { type MessageSendPayload } from './MessageInput'
import QuestionPromptPanel from './QuestionPromptPanel'
import { actionFlowPalette } from '../styles/actionFlowPalette'
import type { OcComposerModelOption } from '../services/opencodeApi'
import { messagesHaveOpenQuestionWithInput } from '../utils/questionPart'
import { collectStaleToolCallIDs } from '../utils/actionMapping'

interface MessagePanelProps {
  messages: OcMessage[]
  latestTodos: CanonicalTodo[]
  archivedTodos: CanonicalTodo[]
  /** Progress for the batch tied to the latest todowrite snapshot; null when no snapshot exists */
  latestTodowriteBatchProgress: LatestTodowriteBatchProgress | null
  loading: boolean
  /** User message sent; polling until assistant reply arrives (SSE may lag) */
  waitingForAssistantReply?: boolean
  sessionId: string
  sessionTitle?: string
  onRefresh: () => void
  onSendMessage: (payload: MessageSendPayload) => Promise<void>
  onAbortMessage?: () => Promise<void>
  aborting?: boolean
  /** Scrollable message column ref (connector geometry) */
  messageListScrollRef?: RefObject<HTMLDivElement | null>
  /** Todo list scroll container (highlight alignment) */
  todoPanelScrollRef?: RefObject<HTMLDivElement | null>
  /** Message indices highlighted for the active subtask */
  highlightMessageIndices?: Set<number> | null
  /** Todo ids highlighted during execution phase */
  highlightTodoIds?: Set<string> | null
  /** Incremented on subtask selection to auto-expand matching todo sections */
  todoPanelRevealGeneration?: number
  onTodoClick?: (todo: OcTodo) => void
  /** PATCH session title via OpenCode */
  onSessionTitleCommit?: (title: string) => Promise<void>
  /** OpenCode question channel requests (SSE `question.asked`) */
  pendingQuestion?: OcPendingQuestionRequest | null
  onQuestionReply?: (answers: string[][]) => Promise<void>
  onQuestionReject?: () => Promise<void>
  questionSubmitting?: boolean
  /** Workspace directory header (`x-opencode-directory`) for inline submits */
  sessionDirectory?: string
  /** Bubble-level question completion hook */
  onQuestionAnswered?: () => Promise<void>
  composerModelRef?: string
  onComposerModelRefChange?: (ref: string) => void
  composerModelOptions?: OcComposerModelOption[]
  composerModelsLoading?: boolean
  composerModelsError?: string | null
  envBootstrapModel?: string | null
  /** 首次拉取会话列表进行中（OpenCode 未响应时会长时间停留） */
  sessionsIndexingBusy?: boolean
  /** 会话列表拉取失败（如 BASE 错误、网络、服务未启动） */
  sessionsBootstrapError?: string | null
  /** 当前会话的 GET /message 失败 */
  sessionDataFetchError?: string | null
  /** 重试加载会话列表 */
  onRetrySessionsBootstrap?: () => void
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
  onRefresh,
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
  composerModelRef = '',
  onComposerModelRefChange,
  composerModelOptions = [],
  composerModelsLoading = false,
  composerModelsError = null,
  envBootstrapModel = null,
  sessionsIndexingBusy = false,
  sessionsBootstrapError = null,
  sessionDataFetchError = null,
  onRetrySessionsBootstrap,
}: MessagePanelProps) {
  const hasInlineQuestion = messagesHaveOpenQuestionWithInput(messages)
  const blockComposerForQuestion =
    hasInlineQuestion ||
    Boolean(pendingQuestion && pendingQuestion.sessionID === sessionId)

  // Derive composer metadata from latest assistant row
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
      // Stale pending once a newer assistant message exists — hide abort affordance
      return !hasLaterAssistant
    })
  })

  const staleToolCallIds = useMemo(() => collectStaleToolCallIDs(messages), [messages])
  const transcriptAnchorNowMs = Date.now()

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

      {(sessionsIndexingBusy || sessionsBootstrapError || sessionDataFetchError) && (
        <div
          role="status"
          style={{
            flexShrink: 0,
            padding: '8px 16px',
            fontSize: 12,
            lineHeight: 1.45,
            borderBottom: '1px solid #E8E8E8',
            background: sessionsBootstrapError || sessionDataFetchError ? '#FFF7ED' : '#F0F9FF',
            color: sessionsBootstrapError || sessionDataFetchError ? '#9A3412' : '#0369A1',
          }}
        >
          {sessionsBootstrapError ? (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>无法加载会话列表</span>
              <span style={{ flex: '1 1 200px', minWidth: 0 }}>{sessionsBootstrapError}</span>
              {onRetrySessionsBootstrap ? (
                <button
                  type="button"
                  onClick={() => onRetrySessionsBootstrap()}
                  style={{
                    padding: '4px 10px',
                    fontSize: 11,
                    fontWeight: 600,
                    borderRadius: 6,
                    border: '1px solid #EA580C',
                    background: '#FFF',
                    color: '#C2410C',
                    cursor: 'pointer',
                  }}
                >
                  重试
                </button>
              ) : null}
            </div>
          ) : sessionDataFetchError ? (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>当前会话消息加载失败</span>
              <span style={{ flex: '1 1 200px', minWidth: 0 }}>{sessionDataFetchError}</span>
              <button
                type="button"
                onClick={() => onRefresh()}
                style={{
                  padding: '4px 10px',
                  fontSize: 11,
                  fontWeight: 600,
                  borderRadius: 6,
                  border: '1px solid #EA580C',
                  background: '#FFF',
                  color: '#C2410C',
                  cursor: 'pointer',
                }}
              >
                重新拉取
              </button>
            </div>
          ) : (
            <span>
              <span style={{ fontWeight: 600 }}>正在连接 OpenCode 并加载会话…</span>
              <span style={{ color: '#64748b', marginLeft: 8 }}>
                若一直停留，请确认服务已启动，且 Vite 环境变量中的 OpenCode 地址与浏览器可访问（含 CORS）。
              </span>
            </span>
          )}
        </div>
      )}

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
          <span style={{ fontWeight: 600 }}>Waiting for the model…</span>
          <span style={{ color: '#64748b', fontWeight: 400 }}>
            Polling in the background — if nothing appears, check OpenCode logs or upstream queue delays.
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
            Loading…
          </div>
        ) : messages.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888', fontSize: 12 }}>
            Pick a session to start chatting
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
                  staleToolCallIds={staleToolCallIds}
                  transcriptAnchorNowMs={transcriptAnchorNowMs}
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

      {/* Todo snapshots + API fallback */}
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

      {/* Composer */}
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
          composerModelRef={composerModelRef}
          onComposerModelRefChange={onComposerModelRefChange}
          composerModelOptions={composerModelOptions}
          composerModelsLoading={composerModelsLoading}
          composerModelsError={composerModelsError}
          envBootstrapModel={envBootstrapModel}
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

  const display = title?.trim() ? title : 'Untitled session'

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
    } catch {
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
      title="Click to rename"
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
