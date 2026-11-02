import { useEffect, useState, type RefObject } from 'react'

export type ScrollNodeMarker = {
  id: string
  label: string
  targetSelector: string
}

type PositionedMarker = ScrollNodeMarker & {
  top: number
}

interface ScrollNodeRailProps {
  scrollContainerRef: RefObject<HTMLDivElement | null>
  markers: ScrollNodeMarker[]
  right?: number
  minPageRatio?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function targetScrollTop(container: HTMLDivElement, target: HTMLElement): number {
  const centered = target.offsetTop - container.clientHeight / 2 + target.offsetHeight / 2
  return clamp(centered, 0, Math.max(0, container.scrollHeight - container.clientHeight))
}

const MARKER_GAP = 12

export default function ScrollNodeRail({
  scrollContainerRef,
  markers,
  right = 8,
  minPageRatio = 1.35,
}: ScrollNodeRailProps) {
  const [positions, setPositions] = useState<PositionedMarker[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || markers.length === 0) {
      setPositions([])
      setActiveId(null)
      return
    }

    let frame = 0
    const update = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const hasEnoughContent = container.scrollHeight > container.clientHeight * minPageRatio
        if (!hasEnoughContent || markers.length < 2) {
          setPositions([])
          setActiveId(null)
          return
        }

        const visibleMarkers = markers.filter((marker) =>
          container.querySelector<HTMLElement>(marker.targetSelector),
        )
        const groupHeight = Math.max(0, (visibleMarkers.length - 1) * MARKER_GAP)
        const groupTop = clamp(
          (container.clientHeight - groupHeight) / 2,
          12,
          Math.max(12, container.clientHeight - groupHeight - 12),
        )
        const next: PositionedMarker[] = []
        let nearestId: string | null = null
        let nearestDistance = Infinity

        visibleMarkers.forEach((marker, index) => {
          const target = container.querySelector<HTMLElement>(marker.targetSelector)
          if (!target) return

          const targetTop = targetScrollTop(container, target)
          const top = groupTop + index * MARKER_GAP
          next.push({ ...marker, top })

          const distance = Math.abs(container.scrollTop - targetTop)
          if (distance < nearestDistance) {
            nearestDistance = distance
            nearestId = marker.id
          }
        })

        setPositions(next)
        setActiveId(nearestId)
      })
    }

    update()
    const resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(container)
    const mutationObserver = new MutationObserver(update)
    mutationObserver.observe(container, { childList: true, subtree: true })
    container.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)

    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      container.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [markers, scrollContainerRef, minPageRatio])

  if (positions.length === 0) return null

  return (
    <div
      aria-hidden={false}
      style={{
        position: 'absolute',
        top: 0,
        right,
        bottom: 0,
        width: 32,
        zIndex: 3,
        pointerEvents: 'none',
      }}
    >
      {positions.map((marker) => {
        const active = marker.id === activeId
        return (
          <button
            key={marker.id}
            type="button"
            title={marker.label}
            aria-label={marker.label}
            onClick={() => {
              const container = scrollContainerRef.current
              const target = container?.querySelector<HTMLElement>(marker.targetSelector)
              target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            }}
            style={{
              position: 'absolute',
              right: active ? 0 : 4,
              top: marker.top,
              width: active ? 16 : 12,
              height: active ? 4 : 3,
              transform: 'translateY(-50%)',
              borderRadius: 999,
              border: 'none',
              padding: 0,
              background: active ? '#8A8A8A' : 'rgba(196, 202, 210, 0.62)',
              boxShadow: 'none',
              cursor: 'pointer',
              pointerEvents: 'auto',
              transition: 'width 0.12s ease, height 0.12s ease, background 0.12s ease',
            }}
          />
        )
      })}
    </div>
  )
}
