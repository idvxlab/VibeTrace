import { useState, useEffect, useMemo, useRef, type RefObject, type WheelEvent } from 'react'
import type { OcMessage, OcPendingPermissionRequest, OcPendingQuestionRequest, OcPermissionReply, OcTodo } from '../types/opencode'
import type { CanonicalTodo, LatestTodowriteBatchProgress } from '../utils/todoRegistry'
import MessageBubble from './MessageBubble'
import TodoPanel from './TodoPanel'
import MessageInput, { type MessageSendPayload } from './MessageInput'
import QuestionPromptPanel from './QuestionPromptPanel'
import PermissionPromptPanel from './PermissionPromptPanel'
import { actionFlowPalette } from '../styles/actionFlowPalette'
import type { OcComposerModelOption } from '../services/opencodeApi'
import { messagesHaveOpenQuestionWithInput } from '../utils/questionPart'
import { collectStaleToolCallIDs } from '../utils/actionMapping'
import { messageHasAgentStepFinishStop } from '../utils/subtaskGrouping'
import ScrollNodeRail, { type ScrollNodeMarker } from './ScrollNodeRail'
import { experimentTelemetry } from '../experiment/telemetry'

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
  /** Experiment: any click inside the Todo panel. */
  onTodoPanelClick?: (detail: {
    target: 'header' | 'section' | 'todo'
    section?: 'open' | 'done' | 'history'
    todoId?: string
  }) => void
  /** PATCH session title via OpenCode */
  onSessionTitleCommit?: (title: string) => Promise<void>
  /** OpenCode question channel requests (SSE `question.asked`) */
  pendingQuestion?: OcPendingQuestionRequest | null
  onQuestionReply?: (answers: string[][]) => Promise<void>
  onQuestionReject?: () => Promise<void>
  questionSubmitting?: boolean
  /** OpenCode permission asks (SSE `permission.asked`) */
  pendingPermission?: OcPendingPermissionRequest | null
  onPermissionReply?: (reply: OcPermissionReply, message?: string) => Promise<void>
  permissionSubmitting?: boolean
  /** How many asks are queued for this session (head is shown in the panel). */
  pendingPermissionQueueSize?: number
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
  /** Initial session list fetch in progress (may linger while OpenCode is unresponsive) */
  sessionsIndexingBusy?: boolean
  /** Session list fetch failed (e.g. BASE URL error, network, service not running) */
  sessionsBootstrapError?: string | null
  /** GET /message for the current session failed */
  sessionDataFetchError?: string | null
  /** Retry loading the session list */
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
  onTodoPanelClick,
  onSessionTitleCommit,
  pendingQuestion,
  onQuestionReply,
  onQuestionReject,
  questionSubmitting,
  pendingPermission,
  onPermissionReply,
  permissionSubmitting,
  pendingPermissionQueueSize = 0,
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
  const blockComposerForPermission = Boolean(
    pendingPermission && pendingPermission.sessionID === sessionId,
  )

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
  /** Latest assistant turn still streaming (no completed timestamp yet) — allow stop even between tools. */
  const lastMessage = messages[messages.length - 1]
  const lastAssistantStopped =
    lastMessage?.info.role === 'assistant' &&
    (lastMessage.info.finish?.trim().toLowerCase() === 'stop' ||
      messageHasAgentStepFinishStop(lastMessage))
  const hasIncompleteAssistant =
    lastMessage?.info.role === 'assistant' &&
    typeof lastMessage.info.time?.completed !== 'number' &&
    !lastAssistantStopped
  const agentBusy =
    hasRunningTool ||
    hasIncompleteAssistant ||
    waitingForAssistantReply ||
    blockComposerForPermission ||
    blockComposerForQuestion

  const staleToolCallIds = useMemo(() => collectStaleToolCallIDs(messages), [messages])
  const transcriptAnchorNowMs = Date.now()
  const userPromptMarkers = useMemo<ScrollNodeMarker[]>(
    () =>
      messages
        .map((msg, idx) =>
          msg.info.role === 'user'
            ? {
                id: msg.info.id || `user-${idx}`,
                label: `User prompt ${idx + 1}`,
                targetSelector: `[data-message-index="${idx}"]`,
              }
            : null,
        )
        .filter((marker): marker is ScrollNodeMarker => marker != null),
    [messages],
  )

  /** Stick to bottom while streaming; pause when the user scrolls up to read history. */
  const stickToBottomRef = useRef(true)
  const [pinnedToLatest, setPinnedToLatest] = useState(true)
  const NEAR_BOTTOM_PX = 96

  const setStickToBottom = (pinned: boolean) => {
    stickToBottomRef.current = pinned
    setPinnedToLatest((prev) => (prev === pinned ? prev : pinned))
  }

  const scrollMessagesToBottom = (behavior: ScrollBehavior = 'auto') => {
    const el = messageListScrollRef?.current
    if (!el) return
    if (behavior === 'smooth') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }

  const jumpToLatest = () => {
    setStickToBottom(true)
    requestAnimationFrame(() => {
      scrollMessagesToBottom('smooth')
    })
  }

  const updateStickToBottomFromScroll = () => {
    const el = messageListScrollRef?.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setStickToBottom(distanceFromBottom <= NEAR_BOTTOM_PX)
  }

  /** Intentional upward scroll immediately releases auto-follow (more reliable than scrollTop during streaming). */
  const handleMessageListWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) setStickToBottom(false)
  }

  /** Jump to latest turn after session load — mw-internal prompts are huge and bury the answer at the top. */
  const wasLoadingRef = useRef(loading)
  useEffect(() => {
    const finishedLoad = wasLoadingRef.current && !loading
    wasLoadingRef.current = loading
    if (!finishedLoad || !sessionId || messages.length === 0) return
    setStickToBottom(true)
    requestAnimationFrame(() => {
      scrollMessagesToBottom()
    })
  }, [loading, sessionId, messages.length, messageListScrollRef])

  /** Follow newly appended / streaming content while the viewport is pinned to the bottom. */
  useEffect(() => {
    if (!stickToBottomRef.current || loading || messages.length === 0) return
    requestAnimationFrame(() => {
      if (!stickToBottomRef.current) return
      scrollMessagesToBottom()
    })
  }, [messages, waitingForAssistantReply, loading, messageListScrollRef])

  /** When the user sends a message, re-pin and jump to the latest turn. */
  const wasWaitingRef = useRef(waitingForAssistantReply)
  useEffect(() => {
    const startedWaiting = !wasWaitingRef.current && waitingForAssistantReply
    wasWaitingRef.current = waitingForAssistantReply
    if (!startedWaiting) return
    setStickToBottom(true)
    requestAnimationFrame(() => {
      scrollMessagesToBottom()
    })
  }, [waitingForAssistantReply, messageListScrollRef])

  /** Catch streaming text / tool-block growth while still stuck to bottom. */
  useEffect(() => {
    const el = messageListScrollRef?.current
    if (!el || typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => {
      if (!stickToBottomRef.current) return
      scrollMessagesToBottom()
    })
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [messageListScrollRef, sessionId])

  /** Reset pin when switching sessions. */
  useEffect(() => {
    setStickToBottom(true)
  }, [sessionId])

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
              <span style={{ fontWeight: 600 }}>Failed to load session list</span>
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
                  Retry
                </button>
              ) : null}
            </div>
          ) : sessionDataFetchError ? (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>Failed to load messages for current session</span>
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
                Reload
              </button>
            </div>
          ) : (
            <span>
              <span style={{ fontWeight: 600 }}>Connecting to OpenCode and loading sessions…</span>
              <span style={{ color: '#64748b', marginLeft: 8 }}>
                If this persists, confirm the service is running and the OpenCode URL in Vite env is reachable from the browser (including CORS).
              </span>
            </span>
          )}
        </div>
      )}

      {/* Messages (scrollable) */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
        }}
      >
        <div
          ref={messageListScrollRef}
          onScroll={() => {
            updateStickToBottomFromScroll()
            experimentTelemetry.onScroll('chat', sessionId || undefined)
          }}
          onWheel={handleMessageListWheel}
          style={{
            height: '100%',
            overflowY: 'auto',
            padding: '16px 28px 16px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '0',
            boxSizing: 'border-box',
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
        {!pinnedToLatest && !loading && messages.length > 0 ? (
          <button
            type="button"
            aria-label="Jump to latest message"
            title="Jump to latest"
            onClick={jumpToLatest}
            style={{
              position: 'absolute',
              right: 28,
              bottom: 16,
              zIndex: 2,
              width: 36,
              height: 36,
              borderRadius: 18,
              border: '1px solid #E5E5E5',
              background: '#FFFFFF',
              color: '#333',
              boxShadow: '0 2px 10px rgba(0,0,0,0.10)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 3v9M4.5 8.5 8 12l3.5-3.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
        {messageListScrollRef ? (
          <ScrollNodeRail scrollContainerRef={messageListScrollRef} markers={userPromptMarkers} right={8} />
        ) : null}
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
            onPanelClick={onTodoPanelClick}
            listScrollRef={todoPanelScrollRef}
          />
        </div>
      )}

      {pendingPermission &&
        pendingPermission.sessionID === sessionId &&
        onPermissionReply && (
        <PermissionPromptPanel
          request={pendingPermission}
          disabled={loading}
          submitting={permissionSubmitting}
          queueSize={pendingPermissionQueueSize}
          onReply={onPermissionReply}
        />
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
          disabled={!sessionId || loading || questionSubmitting || permissionSubmitting || blockComposerForQuestion || blockComposerForPermission}
          onAbort={onAbortMessage}
          isRunning={agentBusy}
          aborting={aborting}
          sessionId={sessionId}
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
