import { useEffect, useId, useRef } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { MappedAction } from '../types/opencode'

const fontSans =
  "'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"

const ANCHOR_GAP = 4
const VIEW_PAD = 8
/** 预估菜单尺寸（用于视口夹紧；与下方 padding 略放大一致） */
const MENU_EST_W = 220
const MENU_EST_H = 100

function IconForkSession({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M8.88887 13.3333C9.7644 13.3334 10.6314 13.161 11.4403 12.826C12.2491 12.491 12.9841 12 13.6032 11.3809C14.2224 10.7618 14.7135 10.0269 15.0485 9.21801C15.3836 8.40914 15.5561 7.54219 15.5561 6.66667C15.5561 5.79114 15.3836 4.9242 15.0485 4.11533C14.7135 3.30646 14.2224 2.5715 13.6032 1.95244C12.9841 1.33338 12.2491 0.842325 11.4403 0.507323C10.6314 0.172322 9.7644 -6.69987e-05 8.88887 1.95331e-08C7.12085 0.000135355 5.42529 0.702574 4.17516 1.9528C2.92503 3.20303 2.22272 4.89865 2.22272 6.66667C2.22272 8.43469 2.92503 10.1303 4.17516 11.3805C5.42529 12.6308 7.12085 13.3332 8.88887 13.3333ZM8.88887 8.88889C8.59705 8.88889 8.30808 8.83141 8.03847 8.71973C7.76885 8.60806 7.52388 8.44437 7.31753 8.23802C7.11117 8.03166 6.94748 7.78669 6.83581 7.51707C6.72413 7.24746 6.66665 6.95849 6.66665 6.66667C6.66665 6.37484 6.72413 6.08587 6.83581 5.81626C6.94748 5.54665 7.11117 5.30167 7.31753 5.09532C7.52388 4.88897 7.76885 4.72528 8.03847 4.6136C8.30808 4.50192 8.59705 4.44444 8.88887 4.44444C9.47824 4.44444 10.0435 4.67857 10.4602 5.09532C10.877 5.51207 11.1111 6.0773 11.1111 6.66667C11.1111 7.25604 10.877 7.82127 10.4602 8.23802C10.0435 8.65476 9.47824 8.88889 8.88887 8.88889ZM31.1111 13.3333C31.9866 13.3334 32.8536 13.161 33.6625 12.826C34.4714 12.491 35.2064 12 35.8255 11.3809C36.4446 10.7618 36.9357 10.0269 37.2708 9.21801C37.6058 8.40914 37.7783 7.54219 37.7783 6.66667C37.7783 5.79114 37.6058 4.9242 37.2708 4.11533C36.9357 3.30646 36.4446 2.5715 35.8255 1.95244C35.2064 1.33338 34.4714 0.842325 33.6625 0.507323C32.8536 0.172322 31.9866 -6.69987e-05 31.1111 1.95331e-08C29.3431 0.000135355 27.6475 0.702574 26.3974 1.9528C25.1472 3.20303 24.4449 4.89865 24.4449 6.66667C24.4449 8.43469 25.1472 10.1303 26.3974 11.3805C27.6475 12.6308 29.3431 13.3332 31.1111 13.3333ZM31.1111 8.88889C30.8193 8.88889 30.5303 8.83141 30.2607 8.71973C29.9911 8.60806 29.7461 8.44437 29.5397 8.23802C29.3334 8.03166 29.1697 7.78669 29.058 7.51707C28.9464 7.24746 28.8889 6.95849 28.8889 6.66667C28.8889 6.37484 28.9464 6.08587 29.058 5.81626C29.1697 5.54665 29.3334 5.30167 29.5397 5.09532C29.7461 4.88897 29.9911 4.72528 30.2607 4.6136C30.5303 4.50192 30.8193 4.44444 31.1111 4.44444C31.7005 4.44444 32.2657 4.67857 32.6824 5.09532C33.0992 5.51207 33.3333 6.0773 33.3333 6.66667C33.3333 7.25604 33.0992 7.82127 32.6824 8.23802C32.2657 8.65476 31.7005 8.88889 31.1111 8.88889ZM8.88887 40C9.7644 40.0001 10.6314 39.8277 11.4403 39.4927C12.2491 39.1577 12.9841 38.6666 13.6032 38.0476C14.2224 37.4285 14.7135 36.6935 15.0485 35.8847C15.3836 35.0758 15.5561 34.2089 15.5561 33.3333C15.5561 32.4578 15.3836 31.5909 15.0485 30.782C14.7135 29.9731 14.2224 29.2382 13.6032 28.6191C12.9841 28 12.2491 27.509 11.4403 27.174C10.6314 26.839 9.7644 26.6666 8.88887 26.6667C7.12085 26.6668 5.42529 27.3692 4.17516 28.6195C2.92503 29.8697 2.22272 31.5653 2.22272 33.3333C2.22272 35.1014 2.92503 36.797 4.17516 38.0472C5.42529 39.2974 7.12085 39.9999 8.88887 40ZM8.88887 35.5556C8.2995 35.5556 7.73427 35.3214 7.31753 34.9047C6.90078 34.4879 6.66665 33.9227 6.66665 33.3333C6.66665 32.744 6.90078 32.1787 7.31753 31.762C7.73427 31.3452 8.2995 31.1111 8.88887 31.1111C9.47824 31.1111 10.0435 31.3452 10.4602 31.762C10.877 32.1787 11.1111 32.744 11.1111 33.3333C11.1111 33.9227 10.877 34.4879 10.4602 34.9047C10.0435 35.3214 9.47824 35.5556 8.88887 35.5556Z"
        fill="currentColor"
      />
      <path d="M6.66666 8.88889V30.3622H11.1111V8.88889H6.66666Z" fill="currentColor" />
      <path
        d="M8.88889 24.4444H20C21.751 24.4444 23.4848 24.0996 25.1024 23.4295C26.7201 22.7594 28.19 21.7773 29.4281 20.5392C30.6662 19.3011 31.6483 17.8312 32.3184 16.2136C32.9885 14.5959 33.3333 12.8621 33.3333 11.1111H28.8889C28.8889 13.4686 27.9524 15.7295 26.2854 17.3965C24.6184 19.0635 22.3575 20 20 20H8.88889V24.4444Z"
        fill="currentColor"
      />
    </svg>
  )
}

function IconExplain({ size = 18, clipId }: { size?: number; clipId: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <g clipPath={`url(#${clipId})`}>
        <path
          d="M5.82 23.5C6.58 23.5 7.2 22.88 7.2 22.12V3.98H25.34C26.1 3.98 26.72 3.36 26.72 2.6C26.72 1.84 26.1 1.22 25.34 1.22H5.82C5.06 1.22 4.44 1.84 4.44 2.6V22.12C4.44 22.88 5.06 23.5 5.82 23.5ZM30.34 24.9C30.28 24.2 29.68 23.64 28.98 23.64H27.84V21.28C27.84 20.52 27.22 19.9 26.46 19.9C25.7 19.9 25.08 20.52 25.08 21.28V25C25.08 25.76 25.7 26.38 26.46 26.38H27.7L28.72 38.72C28.78 39.42 29.38 39.98 30.1 39.98H30.24C30.98 39.9 31.54 39.24 31.48 38.5L30.34 24.9Z"
          fill="currentColor"
        />
        <path
          d="M38.74 11.62C38.48 11.4 36.1 9.44 32.16 9.44C28.22 9.44 25.84 11.4 25.58 11.64C25.52 11.68 25.46 11.74 25.4 11.84L23.2 14.58L18.4 9.96C18.14 9.7 17.78 9.56 17.42 9.58C17.06 9.58 16.7 9.74 16.46 10C16.2 10.26 16.06 10.62 16.08 10.98C16.08 11.34 16.24 11.7 16.5 11.94L22.4 17.64C22.66 17.88 23 18.02 23.36 18.02H23.48C23.86 17.98 24.2 17.8 24.44 17.5L27.46 13.66C27.8 13.4 29.52 12.22 32.16 12.22C34.22 12.22 35.74 12.96 36.46 13.4V23.66H35.32C34.6 23.66 34 24.22 33.94 24.92L32.82 38.52C32.76 39.26 33.3 39.92 34.06 40H34.2C34.92 40 35.52 39.44 35.58 38.74L36.6 26.4H37.84C38.6 26.4 39.22 25.78 39.22 25.02V12.66C39.2 12.26 39.04 11.88 38.74 11.62ZM21.84 23.84H2.16C1.4 23.84 0.779999 24.46 0.779999 25.22C0.779999 25.98 1.4 26.6 2.16 26.6H21.82C22.58 26.6 23.2 25.98 23.2 25.22C23.2 24.46 22.6 23.84 21.84 23.84ZM31.78 9.16C34.3 9.16 36.36 7.1 36.36 4.58C36.36 2.06 34.3 0 31.78 0C29.26 0 27.2 2.06 27.2 4.58C27.2 7.1 29.26 9.16 31.78 9.16ZM31.78 2.76C32.78 2.76 33.6 3.58 33.6 4.58C33.6 5.58 32.78 6.4 31.78 6.4C30.78 6.4 29.96 5.58 29.96 4.58C29.96 3.58 30.78 2.76 31.78 2.76Z"
          fill="currentColor"
        />
      </g>
      <defs>
        <clipPath id={clipId}>
          <rect width="40" height="40" fill="white" />
        </clipPath>
      </defs>
    </svg>
  )
}

function rectsOverlap(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number }
): boolean {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)
}

/** 优先紧贴 action 右下角；仅在贴边或遮挡时平移 */
function clampMenuPosition(
  anchor: DOMRect,
  vw: number,
  vh: number
): { left: number; top: number } {
  const w = MENU_EST_W
  const h = MENU_EST_H
  let left = anchor.right + ANCHOR_GAP
  let top = anchor.bottom + ANCHOR_GAP

  if (left + w > vw - VIEW_PAD) {
    left = vw - w - VIEW_PAD
  }
  if (top + h > vh - VIEW_PAD) {
    top = anchor.top - h - ANCHOR_GAP
  }
  if (top < VIEW_PAD) top = VIEW_PAD
  if (left < VIEW_PAD) left = VIEW_PAD

  const anchorBox = {
    left: anchor.left,
    top: anchor.top,
    right: anchor.right,
    bottom: anchor.bottom,
  }
  let menuBox = { left, top, right: left + w, bottom: top + h }
  if (rectsOverlap(menuBox, anchorBox)) {
    left = anchor.left - w - ANCHOR_GAP
    menuBox = { left, top, right: left + w, bottom: top + h }
    if (left < VIEW_PAD || rectsOverlap(menuBox, anchorBox)) {
      left = anchor.right + ANCHOR_GAP
      top = anchor.bottom + ANCHOR_GAP
      if (left + w > vw - VIEW_PAD) left = vw - w - VIEW_PAD
      if (top + h > vh - VIEW_PAD) top = vh - h - VIEW_PAD
      if (left < VIEW_PAD) left = VIEW_PAD
      if (top < VIEW_PAD) top = VIEW_PAD
    }
  }

  return { left, top }
}

export type ActionFlowContextMenuState = {
  anchorRect: DOMRect
  action: MappedAction & { row: number }
}

type Props = {
  menu: ActionFlowContextMenuState | null
  onClose: () => void
  onFork?: (action: MappedAction & { row: number }) => void
  onAnalysis?: (action: MappedAction & { row: number }) => void
}

export default function ActionFlowContextMenu({ menu, onClose, onFork, onAnalysis }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const reactId = useId().replace(/:/g, '')
  const explainClipId = `action-flow-explain-clip-${reactId}`

  useEffect(() => {
    if (!menu) return
    const onDoc = (e: MouseEvent) => {
      const el = ref.current
      if (el && !el.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu, onClose])

  if (!menu) return null

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const { left, top } = clampMenuPosition(menu.anchorRect, vw, vh)

  const itemStyle: CSSProperties = {
    boxSizing: 'border-box',
    width: '100%',
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    border: 'none',
    borderRadius: 8,
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: fontSans,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.04em',
    color: '#1C1C1C',
    textAlign: 'left',
  }

  const labelStyle: CSSProperties = {
    flex: '1 1 auto',
    minWidth: 96,
    letterSpacing: '0.02em',
    textTransform: 'none' as const,
  }

  const node = (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 10050,
        minWidth: 200,
        maxWidth: 260,
        padding: 6,
        borderRadius: 12,
        background: 'linear-gradient(145deg, rgba(255,255,255,0.98) 0%, rgba(252,252,252,0.98) 100%)',
        boxShadow:
          '0 12px 40px rgba(15, 23, 42, 0.12), 0 0 0 1px rgba(15, 23, 42, 0.06), inset 0 1px 0 rgba(255,255,255,0.9)',
        backdropFilter: 'blur(10px)',
      }}
    >
      {onFork ? (
        <button
          type="button"
          style={{ ...itemStyle, color: '#111827' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(148, 163, 184, 0.15)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
          }}
          onClick={() => {
            onFork(menu.action)
            onClose()
          }}
        >
          <span style={{ color: '#94A3B8', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <IconForkSession />
          </span>
          <span style={labelStyle}>Fork session</span>
        </button>
      ) : null}
      {onAnalysis ? (
        <button
          type="button"
          style={{ ...itemStyle, color: '#111827', marginTop: onFork ? 2 : 0 }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(148, 163, 184, 0.15)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
          }}
          onClick={() => {
            onAnalysis(menu.action)
            onClose()
          }}
        >
          <span style={{ color: '#94A3B8', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <IconExplain clipId={explainClipId} />
          </span>
          <span style={labelStyle}>Explain</span>
        </button>
      ) : null}
    </div>
  )

  return createPortal(node, document.body)
}
