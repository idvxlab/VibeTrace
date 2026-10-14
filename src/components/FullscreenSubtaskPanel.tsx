import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type {
  MappedAction,
  OcMessage,
  OcPendingPermissionRequest,
  OcPermissionTraceEvent,
  OcSessionCompactionEvent,
} from '../types/opencode'
import type { AssistantSubtask } from '../utils/subtaskGrouping'
import type { ForkFromActionContext, ForkPanelSnapshotBundle } from '../utils/forkPanelSnapshot'
import type { MemoryWorkerErrorDiagnosis } from '../services/memoryWorkerApi'
import SubtaskDebugPanel, { type SubtaskTaskTab } from './SubtaskDebugPanel'

type SubtaskSelection = { subtaskIndex: number; actionKey: string } | null

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
  flowLayoutMode: 'timeline' | 'summary'
  selection: SubtaskSelection
  onSelectAction: (subtaskIndex: number, actionKey: string | null) => void
  taskTabs?: SubtaskTaskTab[]
  activeTaskTabId?: string
  onSelectTaskTab?: (id: string) => void
  sessionId?: string
  errorDiagnosisBySubtaskId?: Record<string, MemoryWorkerErrorDiagnosis>
  onPanelSealed?: (subtaskId: string) => void
  onPanelBecameVisible?: (subtaskId: string) => void
  pendingPermission?: OcPendingPermissionRequest | null
  permissionTraces?: OcPermissionTraceEvent[]
  recentCompaction?: OcSessionCompactionEvent | null
}

/**
 * Full-screen VibeTrace overlay: wraps SubtaskDebugPanel.
 * Close with Esc, ×, or backdrop click.
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
  flowLayoutMode,
  selection,
  onSelectAction,
  taskTabs = [],
  activeTaskTabId,
  onSelectTaskTab,
  sessionId,
  errorDiagnosisBySubtaskId,
  onPanelSealed,
  onPanelBecameVisible,
  pendingPermission = null,
  permissionTraces = [],
  recentCompaction = null,
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
      aria-label="VibeTrace"
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
              VibeTrace
            </span>
            <span style={{ fontSize: 11, color: '#8F8F8F' }}>
              {visibleSubtasks.length} subtask{visibleSubtasks.length === 1 ? '' : 's'}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
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
            flowLayoutMode={flowLayoutMode}
            selection={selection}
            onSelectAction={onSelectAction}
            taskTabs={taskTabs}
            activeTaskTabId={activeTaskTabId}
            onSelectTaskTab={onSelectTaskTab}
            sessionId={sessionId}
            errorDiagnosisBySubtaskId={errorDiagnosisBySubtaskId}
            onPanelSealed={onPanelSealed}
            onPanelBecameVisible={onPanelBecameVisible}
            pendingPermission={pendingPermission}
            permissionTraces={permissionTraces}
            recentCompaction={recentCompaction}
          />
        </div>
      </div>
    </div>
  )
}
