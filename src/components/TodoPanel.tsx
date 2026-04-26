import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { OcTodo } from '../types/opencode'
import type { CanonicalTodo, LatestTodowriteBatchProgress } from '../utils/todoRegistry'

/** 分区标题：与「已完成n项」同一套字号/字重/颜色 */
const sectionHeaderLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#171717',
  letterSpacing: 0.2,
}

interface TodoPanelProps {
  /** 当前会话最新列表（含未完成与仍挂在列表上的已完成） */
  latestActive: CanonicalTodo[]
  /** 已离开当前列表的「仅已完成」归档（按 id 去重） */
  archivedCompleted: CanonicalTodo[]
  /** 最近一次 todowrite 快照的本批完成/总量及是否仍在推进 */
  latestTodowriteBatchProgress: LatestTodowriteBatchProgress | null
  highlightTodoIds?: Set<string> | null
  onTodoClick?: (todo: OcTodo) => void
  listScrollRef?: RefObject<HTMLDivElement | null>
  /** 选中子任务时递增，用于自动展开面板与对应分区 */
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
  listScrollRef,
  todoPanelRevealGeneration = 0,
}: TodoPanelProps) {
  const [panelExpanded, setPanelExpanded] = useState(false)
  /** 未完成（pending + in_progress） */
  const [openSectionExpanded, setOpenSectionExpanded] = useState(true)
  /** 仍在当前列表上的已完成 */
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

  /** 顶栏右侧：随列表变化更新（暂无代办 / 进行中 / 已完成） */
  const panelStatusLabel: '暂无代办' | '进行中' | '已完成' =
    latestActive.length === 0 ? '暂无代办' : openTodos.length > 0 ? '进行中' : '已完成'

  const showBatchRatio = Boolean(
    latestTodowriteBatchProgress?.ongoing && latestTodowriteBatchProgress.total > 0
  )

  // 仅响应「选中子任务」信号，避免 todos 列表刷新时重置用户折叠状态
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
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#171717', flexShrink: 0 }}>待办</span>
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
              onClick={() => setOpenSectionExpanded(v => !v)}
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
                进行中
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
                <div style={{ fontSize: 12, color: '#B0B0B0', padding: '4px 6px 8px' }}>暂无未完成项</div>
              ))}
          </div>

          {doneOnList.length > 0 && (
            <div style={{ borderTop: '1px solid #F0F0F0', paddingTop: 4 }}>
              <button
                type="button"
                onClick={() => setDoneOnListExpanded(v => !v)}
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
                  已完成{doneOnList.length}项
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
                onClick={() => setHistoryExpanded(v => !v)}
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
                  历史已完成 <span style={{ fontWeight: 500 }}>({archivedCompleted.length})</span>
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
          title="会话内稳定 id"
        >
          id: {todo.id.slice(0, 8)}…
        </p>
      </div>
    </div>
  )
}
