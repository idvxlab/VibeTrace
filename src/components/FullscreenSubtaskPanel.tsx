import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { MappedAction, OcMessage } from '../types/opencode'
import type { AssistantSubtask } from '../utils/subtaskGrouping'
import type { ForkFromActionContext, ForkPanelSnapshotBundle } from '../utils/forkPanelSnapshot'
import SubtaskDebugPanel from './SubtaskDebugPanel'

interface Props {
  open: boolean
  onClose: () => void
  messages: OcMessage[]
  visibleSubtasks: Array<{ subtask: AssistantSubtask; sourceIndex: number }>
  linkedSubtaskIndex: number | null
  onSelectSubtask: (index: number) => void
  onForkFromAction?: (action: MappedAction & { row: number }, ctx: ForkFromActionContext) => void
  onAnalyzeFromAction?: (action: MappedAction & { row: number }) => void
  sessionDirectory?: string
  forkPanelSnapshotBundle?: ForkPanelSnapshotBundle | null
  /** 默认 220 —— 大致与子任务卡片最小高度一致；后续可改 */
  treemapSize?: number
}

/**
 * 全屏 packing view：复用 SubtaskDebugPanel，但每张子任务卡左侧前置一个
 * actionType 频次 squarified treemap。Esc / × / 点击遮罩关闭。
 */
export default function FullscreenSubtaskPanel({
  open,
  onClose,
  messages,
  visibleSubtasks,
  linkedSubtaskIndex,
  onSelectSubtask,
  onForkFromAction,
  onAnalyzeFromAction,
  sessionDirectory,
  forkPanelSnapshotBundle = null,
  treemapSize = 220,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
        padding: '24px',
        boxSizing: 'border-box',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          flex: 1,
          maxWidth: 1600,
          background: '#FFFFFF',
          border: '1px solid #E8E8E8',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.25)',
        }}
      >
        <div
          style={{
            height: 48,
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #E8E8E8',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: '#171717',
              }}
            >
              子任务 Packing View
            </span>
            <span style={{ fontSize: 11, color: '#8F8F8F' }}>
              共 {visibleSubtasks.length} 个子任务 · 左侧 treemap 按 action 类型出现次数面积切分
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            title="关闭 (Esc)"
            style={{
              width: 32,
              height: 32,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 8,
              color: '#5C5C5C',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#F3F3F3'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            padding: '12px 16px',
            gap: 12,
          }}
        >
          <SubtaskDebugPanel
            messages={messages}
            visibleSubtasks={visibleSubtasks}
            linkedSubtaskIndex={linkedSubtaskIndex}
            onSelectSubtask={onSelectSubtask}
            onForkFromAction={onForkFromAction}
            onAnalyzeFromAction={onAnalyzeFromAction}
            listScrollRef={scrollRef as RefObject<HTMLDivElement | null>}
            sessionDirectory={sessionDirectory}
            forkPanelSnapshotBundle={forkPanelSnapshotBundle}
            leadingTreemapSize={treemapSize}
          />
        </div>
      </div>
    </div>
  )
}
