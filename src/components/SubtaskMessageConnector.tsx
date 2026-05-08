import { useId, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import { actionFlowPalette } from '../styles/actionFlowPalette'

function escAttrSelectorValue(s: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(s)
    : s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

interface Props {
  containerRef: RefObject<HTMLDivElement | null>
  messageScrollRef: RefObject<HTMLDivElement | null>
  todoPanelScrollRef: RefObject<HTMLDivElement | null>
  subtaskScrollRef: RefObject<HTMLDivElement | null>
  subtaskIndex: number | null
  linkedTodoIds: Set<string> | null
  /** Subtask selected + flow glyph selected: transcript block → same glyph in the linked card */
  linkedMessageToAction?: { messageIndex: number; actionKey: string; subtaskIndex: number } | null
  /**
   * No todo-row connector (e.g. planning): still draw the same message→flow line using the segment’s
   * first anchor (`firstFlowAnchorKeyForSubtaskSegment`).
   */
  noTodoAnchor?: { messageIndex: number; actionKey: string } | null
}

/**
 * Bounding rect relative to container, for elements whose `data-todo-link-id` is in `ids`.
 * When `preferredViewportY` is provided, pick the todo row vertically closest to it (narrower spans
 * vs unioning rows), so connectors leave from the highlighted row’s **right edge**.
 */
function pickTodoRowRectRelative(
  container: HTMLElement,
  todoScroll: HTMLElement,
  ids: Set<string>,
  preferredViewportY: number | null,
): DOMRect | null {
  if (ids.size === 0) return null
  const cr = container.getBoundingClientRect()
  type Cand = { r: DOMRect; mid: number }
  const cands: Cand[] = []
  todoScroll.querySelectorAll('[data-todo-link-id]').forEach((el) => {
    const k = el.getAttribute('data-todo-link-id')?.trim() ?? ''
    if (!k || !ids.has(k)) return
    const r = el.getBoundingClientRect()
    const mid = r.top + r.height / 2
    cands.push({ r, mid })
  })
  if (cands.length === 0) return null
  const pick =
    preferredViewportY != null && Number.isFinite(preferredViewportY)
      ? cands.reduce((best, cur) =>
          Math.abs(cur.mid - preferredViewportY!) < Math.abs(best.mid - preferredViewportY!)
            ? cur
            : best,
        cands[0]!)
      : (cands[0] ?? null)
  if (!pick) return null
  const { r } = pick
  return new DOMRect(r.left - cr.left, r.top - cr.top, r.width, r.height)
}

/** Keeps elbows near the todo column so the jog does not drift to the viewport center. */
function orthogonalTodoBridge(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string {
  const gap = Math.abs(x2 - x1)
  if (gap < 10) {
    return `M ${x1} ${y1} L ${x2} ${y2}`
  }
  const jog = Math.min(36, Math.max(12, gap * 0.09))
  if (x2 >= x1) {
    const vx = Math.min(x1 + jog, x2 - 4)
    return `M ${x1} ${y1} L ${vx} ${y1} L ${vx} ${y2} L ${x2} ${y2}`
  }
  const vx = Math.max(x1 - jog, x2 + 4)
  return `M ${x1} ${y1} L ${vx} ${y1} L ${vx} ${y2} L ${x2} ${y2}`
}

export default function SubtaskMessageConnector({
  containerRef,
  messageScrollRef,
  todoPanelScrollRef,
  subtaskScrollRef,
  subtaskIndex,
  linkedTodoIds,
  linkedMessageToAction,
  noTodoAnchor = null,
}: Props) {
  const uid = useId().replace(/:/g, '')
  const markerTodoId = `subtask-link-arrow-${uid}`
  const [todoPathD, setTodoPathD] = useState('')
  const [msgActionPathD, setMsgActionPathD] = useState('')
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const update = () => {
      const container = containerRef.current
      const todoScroll = todoPanelScrollRef.current
      const msgScroll = messageScrollRef.current
      const stScroll = subtaskScrollRef.current
      if (!container) {
        setTodoPathD('')
        setMsgActionPathD('')
        return
      }
      const cr = container.getBoundingClientRect()
      setSvgSize({ w: cr.width, h: cr.height })

      let nextTodoPath = ''
      let nextMsgAction = ''
      const useTodo =
        subtaskIndex !== null && linkedTodoIds !== null && linkedTodoIds.size > 0
      const selectedLink =
        linkedMessageToAction &&
        linkedMessageToAction.subtaskIndex === subtaskIndex &&
        subtaskIndex !== null
          ? linkedMessageToAction
          : null

      /**
       * Message column → subtask **card edge** (same touchdown as todo→card), not onto a flow glyph.
       * Start: transcript chip / bubble for `actionKey`; end: linked card’s left edge at vertical center.
       */
      const msgToFlowPath = (messageIndex: number, actionKey: string): string => {
        if (!msgScroll || !stScroll || subtaskIndex === null) return ''
        const msgWrap = msgScroll.querySelector(`[data-message-index="${messageIndex}"]`)
        const card = stScroll.querySelector(`[data-subtask-card-index="${subtaskIndex}"]`)
        if (!msgWrap || !card) return ''
        const esc = escAttrSelectorValue(actionKey)
        const partEl = msgWrap.querySelector(`[data-transcript-action-key="${esc}"]`)
        const pr = partEl?.getBoundingClientRect()
        const msgRViewport =
          pr && pr.width >= 0.5 && pr.height >= 0.5 ? pr : msgWrap.getBoundingClientRect()
        if (msgRViewport.width < 0.5 || msgRViewport.height < 0.5) return ''

        const srCard = card.getBoundingClientRect()

        const x1 = msgRViewport.right - cr.left
        const y1 = msgRViewport.top - cr.top + msgRViewport.height / 2
        const x2 = srCard.left - cr.left
        const y2 = srCard.top - cr.top + srCard.height / 2
        return orthogonalTodoBridge(x1, y1, x2, y2)
      }

      if (selectedLink) {
        nextMsgAction = msgToFlowPath(selectedLink.messageIndex, selectedLink.actionKey)
      } else if (useTodo && todoScroll && stScroll && subtaskIndex !== null && linkedTodoIds) {
        const card = stScroll.querySelector(`[data-subtask-card-index="${subtaskIndex}"]`)
        if (card) {
          const srCard = card.getBoundingClientRect()
          const anchorY = srCard.top + srCard.height / 2
          const rowRel = pickTodoRowRectRelative(container, todoScroll, linkedTodoIds, anchorY)
          if (rowRel) {
            const x1 = rowRel.left + rowRel.width
            const y1 = rowRel.top + rowRel.height / 2
            const x2 = srCard.left - cr.left
            const y2 = srCard.top - cr.top + srCard.height / 2
            nextTodoPath = orthogonalTodoBridge(x1, y1, x2, y2)
          }
        }
      } else if (noTodoAnchor && subtaskIndex !== null) {
        nextMsgAction = msgToFlowPath(noTodoAnchor.messageIndex, noTodoAnchor.actionKey)
      }

      setTodoPathD(nextTodoPath)
      setMsgActionPathD(nextMsgAction)
    }

    update()
    const ro = new ResizeObserver(update)
    const containerEl = containerRef.current
    if (containerEl) ro.observe(containerEl)
    const todoEl = todoPanelScrollRef.current
    const msgEl = messageScrollRef.current
    const stEl = subtaskScrollRef.current
    todoEl?.addEventListener('scroll', update, { passive: true })
    msgEl?.addEventListener('scroll', update, { passive: true })
    stEl?.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)

    return () => {
      ro.disconnect()
      todoEl?.removeEventListener('scroll', update)
      msgEl?.removeEventListener('scroll', update)
      stEl?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [
    containerRef,
    messageScrollRef,
    todoPanelScrollRef,
    subtaskScrollRef,
    subtaskIndex,
    linkedTodoIds,
    linkedMessageToAction,
    noTodoAnchor,
  ])

  if ((!todoPathD && !msgActionPathD) || svgSize.w <= 0) return null

  const strokeTodo = actionFlowPalette.arrow

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
        <marker id={markerTodoId} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill={strokeTodo} />
        </marker>
      </defs>
      {todoPathD ? (
        <path
          d={todoPathD}
          fill="none"
          stroke={strokeTodo}
          strokeWidth={1.8}
          strokeLinecap="round"
          markerEnd={`url(#${markerTodoId})`}
        />
      ) : null}
      {msgActionPathD ? (
        <path
          d={msgActionPathD}
          fill="none"
          stroke={strokeTodo}
          strokeWidth={1.8}
          strokeLinecap="round"
          markerEnd={`url(#${markerTodoId})`}
        />
      ) : null}
    </svg>
  )
}
