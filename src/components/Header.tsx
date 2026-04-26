import type { OcSession } from '../types/opencode'

interface HeaderProps {
  selectedSession: OcSession | undefined
  apiConnected: boolean
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}

export default function Header({
  selectedSession,
  apiConnected,
  sidebarCollapsed,
  onToggleSidebar,
}: HeaderProps) {
  return (
    <header
      style={{
        height: 40,
        background: 'var(--color-bg-base)',
        borderBottom: '1px solid var(--color-border-light)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        gap: '8px',
      }}
    >
      {/* Toggle Sidebar Button */}
      {sidebarCollapsed && (
        <button
          onClick={onToggleSidebar}
          style={{
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
          }}
          title="展开侧边栏"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-primary)" strokeWidth="2">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
      )}

      {/* Current Session Title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {selectedSession && (
          <>
            <span
              style={{
                fontSize: '14px',
                fontWeight: 500,
                color: 'var(--color-text-primary)',
              }}
            >
              {selectedSession.title || 'Untitled'}
            </span>
            <span
              style={{
                fontSize: '12px',
                color: 'var(--color-text-tertiary)',
              }}
              title={selectedSession.directory}
            >
              · {selectedSession.directory?.split(/[\\/]/).pop()}
            </span>
          </>
        )}
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Connection Status */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          fontSize: '12px',
          color: apiConnected ? 'var(--color-success)' : 'var(--color-error)',
        }}
      >
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: apiConnected ? 'var(--color-success)' : 'var(--color-error)',
          }}
        />
        {apiConnected ? 'Connected' : 'Disconnected'}
      </div>

      {/* Menu Button */}
      <button
        style={{
          width: 28,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          borderRadius: 6,
          cursor: 'pointer',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="2">
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </button>
    </header>
  )
}
