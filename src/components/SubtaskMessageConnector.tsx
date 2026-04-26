import { useId, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import { actionFlowPalette } from '../styles/actionFlowPalette'

interface Props {
  /** 包住中栏+右栏、position:relative 的节点 */
  containerRef: RefObject<HTMLDivElement | null>
  /** Todo 列表面板滚动容器（execution 子任务连线到待办行） */
  todoPanelScrollRef: RefObject<HTMLDivElement | null>
  /** 右侧子任务列表滚动容器 */
  subtaskScrollRef: RefObject<HTMLDivElement | null>
  subtaskIndex: number | null
  /** 与选中子任务关联的 todo id */
  linkedTodoIds: Set<string> | null
}

function unionTodoHighlightRects(
  container: HTMLElement,
  todoScroll: HTMLElement,
  ids: Set<string>
): DOMRect | null {
  if (ids.size === 0) return null
  const cr = container.getBoundingClientRect()
  let top = Infinity
  let left = Infinity
  let right = -Infinity
  let bottom = -Infinity
  let any = false
  const nodes = todoScroll.querySelectorAll('[data-todo-link-id]')
  nodes.forEach(el => {
    const k = el.getAttribute('data-todo-link-id')?.trim() ?? ''
    if (!k || !ids.has(k)) return
    const r = el.getBoundingClientRect()
    any = true
    top = Math.min(top, r.top)
    left = Math.min(left, r.left)
    right = Math.max(right, r.right)
    bottom = Math.max(bottom, r.bottom)
  })
  if (!any) return null
  return new DOMRect(left - cr.left, top - cr.top, right - left, bottom - top)
}

/**
 * 正交折线：Todo/消息块右侧中点 → 子任务卡片左侧中点。
 * 末段为水平线，与 SVG marker orient=auto 一致，且垂直于竖直卡片边。
 */
function orthogonalPathD(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  clearance = 8
): string {
  const lo = Math.min(x1, x2)
  const hi = Math.max(x1, x2)
  const span = hi - lo
  if (span < 6) {
    return `M ${x1} ${y1} L ${x2} ${y2}`
  }
  const inset = Math.min(clearance, span * 0.35)
  const mid = lo + span * 0.5
  const elbowX =
    x2 >= x1 ? Math.min(mid, hi - inset) : Math.max(mid, lo + inset)
  const margin = Math.max(2, inset * 0.5)
  const ex = Math.min(Math.max(elbowX, lo + margin), hi - margin)
  return `M ${x1} ${y1} L ${ex} ${y1} L ${ex} ${y2} L ${x2} ${y2}`
}

export default function SubtaskMessageConnector({
  containerRef,
  todoPanelScrollRef,
  subtaskScrollRef,
  subtaskIndex,
  linkedTodoIds,
}: Props) {
  const mid = useId().replace(/:/g, '')
  const markerEndId = `subtask-link-arrow-${mid}`
  const [pathD, setPathD] = useState('')
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const useTodo =
      subtaskIndex !== null && linkedTodoIds !== null && linkedTodoIds.size > 0
    const active = subtaskIndex !== null && useTodo
    if (!active) {
      setPathD('')
      return
    }

    const update = () => {
      const container = containerRef.current
      const todoScroll = todoPanelScrollRef.current
      const stScroll = subtaskScrollRef.current
      if (!container || !stScroll || subtaskIndex === null) {
        setPathD('')
        return
      }

      const cr = container.getBoundingClientRect()
      setSvgSize({ w: cr.width, h: cr.height })

      let union: DOMRect | null = null
      if (useTodo && linkedTodoIds && todoScroll) {
        union = unionTodoHighlightRects(container, todoScroll, linkedTodoIds)
      }

      const card = stScroll.querySelector(`[data-subtask-card-index="${subtaskIndex}"]`)
      if (!union || !card) {
        setPathD('')
        return
      }

      const srCard = card.getBoundingClientRect()
      const x1 = union.right
      const y1 = union.top + union.height / 2
      const x2 = srCard.left - cr.left
      const y2 = srCard.top - cr.top + srCard.height / 2

      setPathD(orthogonalPathD(x1, y1, x2, y2))
    }

    update()
    const ro = new ResizeObserver(update)
    const containerEl = containerRef.current
    if (containerEl) ro.observe(containerEl)
    const todoEl = todoPanelScrollRef.current
    const stEl = subtaskScrollRef.current
    todoEl?.addEventListener('scroll', update, { passive: true })
    stEl?.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)

    return () => {
      ro.disconnect()
      todoEl?.removeEventListener('scroll', update)
      stEl?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [
    containerRef,
    todoPanelScrollRef,
    subtaskScrollRef,
    subtaskIndex,
    linkedTodoIds,
  ])

  if (!pathD || svgSize.w <= 0) return null

  return (
    <svg
      width={svgSize.w}
      height={svgSize.h}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        pointerEvents: 'none',
        zIndex: 5,
        overflow: 'visible',
      }}
      aria-hidden
    >
      <defs>
        <marker
          id={markerEndId}
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L6,3 L0,6 z" fill={actionFlowPalette.arrow} />
        </marker>
      </defs>
      <path
        d={pathD}
        fill="none"
        stroke={actionFlowPalette.arrow}
        strokeWidth={1.8}
        strokeLinecap="round"
        markerEnd={`url(#${markerEndId})`}
      />
    </svg>
  )
}
