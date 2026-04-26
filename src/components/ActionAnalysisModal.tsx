import type { CSSProperties, ReactNode } from 'react'
import type { MappedAction } from '../types/opencode'

const fontSans =
  "'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"

type Props = {
  action: MappedAction & { row: number }
  onClose: () => void
}

function row(label: string, value: string | undefined): ReactNode {
  if (value === undefined || value === '') return null
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '112px 1fr',
        gap: 10,
        alignItems: 'start',
        padding: '6px 0',
        borderBottom: '1px solid rgba(15, 23, 42, 0.06)',
        fontFamily: fontSans,
        fontSize: 12,
        lineHeight: 1.45,
        color: '#334155',
      }}
    >
      <div style={{ fontWeight: 600, color: '#64748B' }}>{label}</div>
      <div style={{ wordBreak: 'break-all', color: '#0F172A' }}>{value}</div>
    </div>
  )
}

export default function ActionAnalysisModal({ action, onClose }: Props) {
  const overlay: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 10060,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: 'rgba(15, 23, 42, 0.35)',
    backdropFilter: 'blur(6px)',
  }

  const card: CSSProperties = {
    width: 'min(440px, 100%)',
    maxHeight: 'min(72vh, 640px)',
    overflow: 'auto',
    borderRadius: 16,
    padding: '20px 22px 18px',
    background: 'linear-gradient(180deg, #FFFFFF 0%, #FAFAFA 100%)',
    boxShadow:
      '0 24px 80px rgba(15, 23, 42, 0.18), 0 0 0 1px rgba(15, 23, 42, 0.06)',
  }

  const hint =
    '对照状态与消息边界，便于判断卡住、未回流或错因；需要分支实验请用 Fork session。'

  return (
    <div style={overlay} onMouseDown={onClose}>
      <div
        style={card}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-labelledby="action-analysis-title"
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div>
            <div
              id="action-analysis-title"
              style={{
                fontFamily: fontSans,
                fontSize: 16,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: '#0F172A',
              }}
            >
              Explain
            </div>
            <div
              style={{
                marginTop: 6,
                fontFamily: fontSans,
                fontSize: 12,
                lineHeight: 1.55,
                color: '#64748B',
              }}
            >
              {hint}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              flexShrink: 0,
              width: 32,
              height: 32,
              borderRadius: 10,
              border: '1px solid rgba(15, 23, 42, 0.08)',
              background: '#FFFFFF',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: '28px',
              color: '#64748B',
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div style={{ marginTop: 4 }}>
          {row('Action', String(action.actionType))}
          {row('Status', String(action.status))}
          {row('Duration', action.durationMs > 0 ? `${(action.durationMs / 1000).toFixed(2)}s` : undefined)}
          {row('Source', action.source)}
          {row('Session', action.sessionID)}
          {row('Message', action.messageID)}
          {row('Call', action.callID)}
          {row('Parallel group', action.parallelGroupId)}
          {row('Branch session', action.branchChildSessionID)}
          {row('Error', action.errorMessage ?? action.errorName)}
        </div>
      </div>
    </div>
  )
}
