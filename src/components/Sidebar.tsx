import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { OcSession } from '../types/opencode'
import { folderDisplayName } from '../utils/sessionFolders'
import ExperimentBar from '../experiment/ExperimentBar'
import { experimentTelemetry } from '../experiment/telemetry'

interface SidebarProps {
  /** Sessions in the selected folder (sorted, filtered). */
  sessionsInFolder: OcSession[]
  directories: string[]
  selectedDirectory: string
  onSelectDirectory: (dir: string) => void | Promise<void>
  selectedSessionId: string
  onSelectSession: (id: string) => void
  onCreateSession: () => void | Promise<void>
  creatingSession?: boolean
  /** Calls OpenCode DELETE /session/:id — removes session from UI (server deletes data). */
  onArchiveSession?: (sessionId: string) => void | Promise<void>
  archivingSessionId?: string | null
  collapsed: boolean
  onToggle: () => void
  apiConnected: boolean
  onAddDirectory?: () => void
  onCloseDirectory?: (dir: string) => void
  sessionListWidth?: number
  isResizingSessionList?: boolean
  onSessionListResizePointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void
}

const RAIL_WIDTH = 44
type DirMenu = { x: number; y: number; dir: string }

export default function Sidebar({
  sessionsInFolder,
  directories,
  selectedDirectory,
  onSelectDirectory,
  selectedSessionId,
  onSelectSession,
  onCreateSession,
  creatingSession,
  onArchiveSession,
  archivingSessionId,
  collapsed,
  onToggle,
  apiConnected,
  onAddDirectory,
  onCloseDirectory,
  sessionListWidth = 240,
  isResizingSessionList = false,
  onSessionListResizePointerDown,
}: SidebarProps) {
  const [hoverSessionId, setHoverSessionId] = useState<string | null>(null)
  const [dirMenu, setDirMenu] = useState<DirMenu | null>(null)
  const dirMenuRef = useRef<HTMLDivElement>(null)
  const titleName = useMemo(
    () => folderDisplayName(selectedDirectory),
    [selectedDirectory],
  )
  useEffect(() => {
    if (!dirMenu) return
    const onPointer = (e: MouseEvent) => {
      if (!dirMenuRef.current?.contains(e.target as Node)) {
        setDirMenu(null)
      }
    }
    const onScroll = () => setDirMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDirMenu(null)
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [dirMenu])

  if (collapsed) {
    return (
      <div
        style={{
          width: 48,
          height: '100%',
          background: '#FFFFFF',
          borderRight: '1px solid #E8E8E8',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 12,
          flexShrink: 0,
        }}
      >
        <button
          onClick={onToggle}
          style={{
            width: 32,
            height: 32,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
          title="Expand sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#171717" strokeWidth="2">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        flexShrink: 0,
      }}
    >
      {/* Folder rail */}
      <div
        style={{
          width: RAIL_WIDTH,
          height: '100%',
          background: '#FAFAFA',
          borderRight: '1px solid #E8E8E8',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingTop: 8,
            paddingBottom: 8,
            gap: 6,
            overflowY: 'auto',
          }}
        >
          {onAddDirectory && (
            <button
              type="button"
              title="Add workspace directory"
              onClick={onAddDirectory}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                border: '1px solid #D8C2EB',
                background: 'linear-gradient(180deg, #FCF8FF 0%, #F3E9FB 100%)',
                cursor: 'pointer',
                color: '#6D35A1',
                fontSize: 18,
                fontWeight: 500,
                lineHeight: '28px',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.75)',
                flexShrink: 0,
              }}
            >
              +
            </button>
          )}
          {directories.map((dir) => {
            const active = dir === selectedDirectory
            const label = folderDisplayName(dir).slice(0, 2)
            return (
              <button
                key={dir || '__root__'}
                type="button"
                title={dir}
                onClick={() => onSelectDirectory(dir)}
                onContextMenu={(e) => {
                  if (!onCloseDirectory) return
                  e.preventDefault()
                  setDirMenu({ x: e.clientX, y: e.clientY, dir })
                }}
                style={{
                  width: 32,
                  minHeight: 32,
                  padding: '4px 2px',
                  borderRadius: 8,
                  border: active ? '1px solid #8445BC' : '1px solid transparent',
                  background: active ? '#F0E6FA' : 'transparent',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 600,
                  color: active ? '#5B2D82' : '#525252',
                  lineHeight: 1.15,
                  wordBreak: 'break-all',
                  flexShrink: 0,
                }}
              >
                {label}
              </button>
            )
          })}
        </div>

        <ExperimentBar directory={selectedDirectory || ''} />
      </div>

      {/* Session list */}
      <div
        onPointerEnter={() => experimentTelemetry.enterPanelFocus('session')}
        onPointerLeave={() => experimentTelemetry.leavePanelFocus('session')}
        style={{
          width: sessionListWidth,
          height: '100%',
          background: '#FFFFFF',
          borderRight: '1px solid #E8E8E8',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          position: 'relative',
        }}
      >
        <div
          style={{
            height: 48,
            padding: '0 12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #E8E8E8',
            minWidth: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span
              title={selectedDirectory || 'Active workspace'}
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: '#171717',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {titleName}
            </span>
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: apiConnected ? '#0ABE00' : '#FF3B30',
                flexShrink: 0,
              }}
              title={apiConnected ? 'OpenCode connected' : 'Not connected'}
            />
          </div>
          <button
            onClick={onToggle}
            style={{
              width: 24,
              height: 24,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              flexShrink: 0,
            }}
            title="Collapse sidebar"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8F8F8F" strokeWidth="2">
              <path d="M11 19l-7-7 7-7M18 19l-7-7 7-7" />
            </svg>
          </button>
        </div>

        <div style={{ padding: '8px 12px' }}>
          <button
            type="button"
            disabled={creatingSession}
            onClick={() => void onCreateSession()}
            style={{
              width: '100%',
              height: 36,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              background: creatingSession ? '#ECECEC' : '#8445BC',
              color: '#FFFFFF',
              border: 'none',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              cursor: creatingSession ? 'wait' : 'pointer',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {creatingSession ? 'Creating…' : 'New session'}
          </button>
        </div>

        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '4px 0',
          }}
        >
          {sessionsInFolder.length === 0 ? (
            <div style={{ padding: '12px 14px', fontSize: 12, color: '#8F8F8F', lineHeight: 1.5 }}>
              No sessions in this folder yet. Use &quot;New session&quot; to start.
            </div>
          ) : (
            sessionsInFolder.map((session) => (
              <div
                key={session.id}
                onMouseEnter={() => setHoverSessionId(session.id)}
                onMouseLeave={() => setHoverSessionId(null)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 8px 4px 12px',
                  background: session.id === selectedSessionId ? '#F0E6FA' : 'transparent',
                  borderRadius: 6,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    experimentTelemetry.onSessionPanelInteract(session.id)
                    onSelectSession(session.id)
                  }}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '4px 0',
                    background: 'transparent',
                    border: 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: session.id === selectedSessionId ? '#8445BC' : '#C7C7C7',
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      color: '#171717',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={session.title || 'Untitled'}
                  >
                    {session.title || 'Untitled'}
                  </span>
                </button>
                {onArchiveSession && (
                  <button
                    type="button"
                    title="Delete session (removes from server)"
                    disabled={archivingSessionId === session.id}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onArchiveSession(session.id)
                    }}
                    style={{
                      flexShrink: 0,
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'transparent',
                      border: 'none',
                      borderRadius: 6,
                      cursor: archivingSessionId === session.id ? 'wait' : 'pointer',
                      opacity: hoverSessionId === session.id ? 1 : 0.35,
                      color: '#737373',
                    }}
                  >
                    {archivingSessionId === session.id ? (
                      <span style={{ fontSize: 11 }}>…</span>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 8v13H3V8M1 3h22v5H1V3zM10 12h4" />
                      </svg>
                    )}
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        {onSessionListResizePointerDown ? (
          <div
            role="separator"
            aria-label="Resize session history panel"
            aria-orientation="vertical"
            title="Drag to resize session history"
            onPointerDown={onSessionListResizePointerDown}
            style={{
              position: 'absolute',
              top: 0,
              right: -4,
              bottom: 0,
              width: 8,
              cursor: 'col-resize',
              zIndex: 5,
              touchAction: 'none',
              background: isResizingSessionList ? '#EEF3FF' : 'transparent',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 3,
                width: 1,
                background: isResizingSessionList ? '#5A8FFF' : '#E1E1E1',
              }}
            />
          </div>
        ) : null}
      </div>
      {dirMenu && onCloseDirectory && (
        <div
          ref={dirMenuRef}
          style={{
            position: 'fixed',
            top: dirMenu.y,
            left: dirMenu.x,
            zIndex: 2000,
            minWidth: 148,
            background: '#FFFFFF',
            border: '1px solid #E7E7E7',
            borderRadius: 8,
            boxShadow: '0 6px 24px rgba(0,0,0,0.14)',
            padding: 4,
          }}
        >
          <button
            type="button"
            onClick={() => {
              onCloseDirectory(dirMenu.dir)
              setDirMenu(null)
            }}
            style={{
              width: '100%',
              height: 30,
              border: 'none',
              borderRadius: 6,
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              padding: '0 10px',
              fontSize: 12,
              color: '#B42318',
            }}
          >
            Close Workspace
          </button>
        </div>
      )}
    </div>
  )
}
