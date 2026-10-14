import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { experimentTelemetry } from '../experiment/telemetry'
import type { OcTodo } from '../types/opencode'
import type { CanonicalTodo, LatestTodowriteBatchProgress } from '../utils/todoRegistry'

/** Section header typography shared with completed counts */
const sectionHeaderLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#171717',
  letterSpacing: 0.2,
}

interface TodoPanelProps {
  /** Latest merged list (open + still-listed completed) */
  latestActive: CanonicalTodo[]
  /** Completed items that left the active list (deduped by id) */
  archivedCompleted: CanonicalTodo[]
  /** Completion ratio for the freshest todowrite batch */
  latestTodowriteBatchProgress: LatestTodowriteBatchProgress | null
  highlightTodoIds?: Set<string> | null
  onTodoClick?: (todo: OcTodo) => void
  /** Any click inside the Todo panel (header, section toggles, todo rows). */
  onPanelClick?: (detail: {
    target: 'header' | 'section' | 'todo'
    section?: 'open' | 'done' | 'history'
    todoId?: string
  }) => void
  listScrollRef?: RefObject<HTMLDivElement | null>
  /** Increment when selecting a subtask — auto-expands relevant sections */
  todoPanelRevealGeneration?: number
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#8F8F8F"
      strokeWidth="2"
      style={{
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 0.15s ease',
        flexShrink: 0,
      }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

export default function TodoPanel({
  latestActive,
  archivedCompleted,
  latestTodowriteBatchProgress,
  highlightTodoIds,
  onTodoClick,
  onPanelClick,
  listScrollRef,
  todoPanelRevealGeneration = 0,
}: TodoPanelProps) {
  const [panelExpanded, setPanelExpanded] = useState(false)
  /** Open work (pending + in_progress) */
  const [openSectionExpanded, setOpenSectionExpanded] = useState(true)
  /** Completed items still shown in the active list */
  const [doneOnListExpanded, setDoneOnListExpanded] = useState(false)
  const [historyExpanded, setHistoryExpanded] = useState(false)

  const latestActiveRef = useRef(latestActive)
  const archivedRef = useRef(archivedCompleted)
  const highlightRef = useRef(highlightTodoIds)
  latestActiveRef.current = latestActive
  archivedRef.current = archivedCompleted
  highlightRef.current = highlightTodoIds

  const openTodos = latestActive.filter(t => t.status !== 'completed')
  const doneOnList = latestActive.filter(t => t.status === 'completed')

  /** Header chips: empty list / in progress / all done */
  const panelStatusLabel: 'None' | 'In progress' | 'All done' =
    latestActive.length === 0 ? 'None' : openTodos.length > 0 ? 'In progress' : 'All done'

  const showBatchRatio = Boolean(
    latestTodowriteBatchProgress?.ongoing && latestTodowriteBatchProgress.total > 0
  )

  // React only to subtask-selection signals so routine todo refreshes don't reset collapse state
  useLayoutEffect(() => {
    if (todoPanelRevealGeneration <= 0) return

    setPanelExpanded(true)

    const la = latestActiveRef.current
    const arc = archivedRef.current
    const ids = highlightRef.current
    const hasHighlight = Boolean(ids && ids.size > 0)
    let hitOpen = false
    let hitDoneOnList = false
    let hitHistory = false
    if (ids && ids.size > 0) {
      for (const id of ids) {
        if (la.some(t => t.id === id && t.status !== 'completed')) hitOpen = true
        if (la.some(t => t.id === id && t.status === 'completed')) hitDoneOnList = true
        if (arc.some(t => t.id === id)) hitHistory = true
      }
    }

    if (!hasHighlight) {
      setOpenSectionExpanded(true)
      setDoneOnListExpanded(false)
      setHistoryExpanded(false)
      return
    }

    setOpenSectionExpanded(hitOpen)
    setDoneOnListExpanded(hitDoneOnList)
    setHistoryExpanded(hitHistory)

    if (!hitOpen && !hitDoneOnList && !hitHistory) {
      setOpenSectionExpanded(true)
      setDoneOnListExpanded(false)
      setHistoryExpanded(false)
    }
  }, [todoPanelRevealGeneration])

  if (latestActive.length === 0 && archivedCompleted.length === 0) return null

  const toggleMainPanel = () => {
    onPanelClick?.({ target: 'header' })
    setPanelExpanded(prev => {
      const next = !prev
      if (next) {
        setOpenSectionExpanded(true)
        setDoneOnListExpanded(false)
        setHistoryExpanded(false)
      }
      return next
    })
  }

  const handleTodoPick = (todo: CanonicalTodo) => {
    onPanelClick?.({ target: 'todo', todoId: todo.id })
    setPanelExpanded(true)
    const inHistory = archivedCompleted.some(t => t.id === todo.id)
    if (inHistory) {
      setHistoryExpanded(true)
      setOpenSectionExpanded(false)
      setDoneOnListExpanded(false)
    } else if (todo.status === 'completed') {
      setDoneOnListExpanded(true)
      setOpenSectionExpanded(false)
      setHistoryExpanded(false)
    } else {
      setOpenSectionExpanded(true)
      setDoneOnListExpanded(false)
      setHistoryExpanded(false)
    }
    onTodoClick?.(todo)
  }

  return (
    <div
      onPointerEnter={() => experimentTelemetry.enterPanelFocus('todo')}
      onPointerLeave={(e) => {
        const related = e.relatedTarget as Node | null
        const column = (e.currentTarget as HTMLElement).closest('[data-exp-focus="chat-column"]')
        const stayInChat = Boolean(column && related && column.contains(related))
        experimentTelemetry.leavePanelFocus('todo', stayInChat ? 'chat' : undefined)
      }}
      style={{
        maxWidth: '100%',
        margin: '0 16px',
        background: '#FFFFFF',
        border: '1px solid #E8E8E8',
        borderRadius: '8px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={toggleMainPanel}
        style={{
          width: '100%',
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            minWidth: 0,
            textAlign: 'left',
            flex: 1,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6F6F6F" strokeWidth="2" style={{ flexShrink: 0 }}>
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <path d="M9 12l2 2 4-4" />
          </svg>
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#171717', flexShrink: 0 }}>Todos</span>
          <span
            style={{
              fontSize: '12px',
              fontWeight: 400,
              color: '#8F8F8F',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {panelStatusLabel}
          </span>
        </div>
        <Chevron open={panelExpanded} />
      </button>

      {panelExpanded && (
        <div
          ref={listScrollRef}
          style={{
            padding: '0 12px 8px',
            maxHeight: 320,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ borderTop: '1px solid #F0F0F0', paddingTop: 6 }}>
            <button
              type="button"
              onClick={() => {
                onPanelClick?.({ target: 'section', section: 'open' })
                setOpenSectionExpanded(v => !v)
              }}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 4px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                borderRadius: 6,
              }}
            >
              <span style={sectionHeaderLabelStyle}>
                In progress
                {showBatchRatio && latestTodowriteBatchProgress ? (
                  <>
                    {' '}
                    <span style={{ fontWeight: 500, color: '#8445BC' }}>
                      {latestTodowriteBatchProgress.completed}/{latestTodowriteBatchProgress.total}
                    </span>
                  </>
                ) : null}
              </span>
              <Chevron open={openSectionExpanded} />
            </button>
            {openSectionExpanded &&
              (openTodos.length > 0 ? (
                openTodos.map((todo, ti) => (
                  <TodoItem
                    key={`open-${todo.id}-${ti}`}
                    todo={todo}
                    highlighted={Boolean(highlightTodoIds?.has(todo.id))}
                    clickable={Boolean(onTodoClick)}
                    onPick={handleTodoPick}
                  />
                ))
              ) : (
                <div style={{ fontSize: 12, color: '#B0B0B0', padding: '4px 6px 8px' }}>No open todos</div>
              ))}
          </div>

          {doneOnList.length > 0 && (
            <div style={{ borderTop: '1px solid #F0F0F0', paddingTop: 4 }}>
              <button
                type="button"
                onClick={() => {
                  onPanelClick?.({ target: 'section', section: 'done' })
                  setDoneOnListExpanded(v => !v)
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 4px',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  borderRadius: 6,
                }}
              >
                <span style={sectionHeaderLabelStyle}>
                  Completed · {doneOnList.length}
                </span>
                <Chevron open={doneOnListExpanded} />
              </button>
              {doneOnListExpanded &&
                doneOnList.map((todo, ti) => (
                  <TodoItem
                    key={`done-${todo.id}-${ti}`}
                    todo={todo}
                    highlighted={Boolean(highlightTodoIds?.has(todo.id))}
                    clickable={Boolean(onTodoClick)}
                    onPick={handleTodoPick}
                  />
                ))}
            </div>
          )}

          {archivedCompleted.length > 0 && (
            <div style={{ borderTop: '1px solid #F0F0F0', paddingTop: 4 }}>
              <button
                type="button"
                onClick={() => {
                  onPanelClick?.({ target: 'section', section: 'history' })
                  setHistoryExpanded(v => !v)
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 4px',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  borderRadius: 6,
                }}
              >
                <span style={sectionHeaderLabelStyle}>
                  Completed history <span style={{ fontWeight: 500 }}>({archivedCompleted.length})</span>
                </span>
                <Chevron open={historyExpanded} />
              </button>
              {historyExpanded &&
                archivedCompleted.map((todo, ti) => (
                  <TodoItem
                    key={`arc-${todo.id}-${ti}`}
                    todo={todo}
                    highlighted={Boolean(highlightTodoIds?.has(todo.id))}
                    clickable={Boolean(onTodoClick)}
                    onPick={handleTodoPick}
                  />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TodoItem({
  todo,
  highlighted,
  clickable,
  onPick,
}: {
  todo: CanonicalTodo
  highlighted: boolean
  clickable?: boolean
  onPick?: (todo: CanonicalTodo) => void
}) {
  const isCompleted = todo.status === 'completed'
  const isInProgress = todo.status === 'in_progress'

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      data-todo-link-id={todo.id}
      onClick={clickable && onPick ? () => onPick(todo) : undefined}
      onKeyDown={
        clickable && onPick
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onPick(todo)
              }
            }
          : undefined
      }
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '4px 6px',
        margin: '0 -4px',
        borderRadius: 6,
        outline: 'none',
        opacity: isCompleted ? 0.55 : 1,
        cursor: clickable ? 'pointer' : 'default',
        background: highlighted ? 'rgba(132, 69, 188, 0.12)' : 'transparent',
        boxShadow: highlighted ? '0 0 0 1px rgba(132, 69, 188, 0.35)' : 'none',
        transition: 'background 0.15s ease, box-shadow 0.15s ease',
      }}
    >
      <div
        style={{
          width: 14,
          height: 14,
          marginTop: 2,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {isCompleted ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0ABE00" strokeWidth="2.5">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        ) : isInProgress ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8445BC" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 3" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8F8F8F" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
          </svg>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontSize: '13px',
            color: isCompleted ? '#8F8F8F' : '#171717',
            textDecoration: isCompleted ? 'line-through' : 'none',
            lineHeight: 1.4,
            wordBreak: 'break-word',
            margin: 0,
          }}
        >
          {todo.content}
        </p>
        <p
          style={{
            margin: '2px 0 0',
            fontSize: 9,
            color: '#B0B0B0',
            fontFamily: 'ui-monospace, monospace',
            wordBreak: 'break-all',
          }}
          title="Stable session-scoped id"
        >
          id: {todo.id.slice(0, 8)}…
        </p>
      </div>
    </div>
  )
}
