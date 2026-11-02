import type { CSSProperties } from 'react'
import type { OcPendingPermissionRequest, OcPermissionReply } from '../types/opencode'

interface PermissionPromptPanelProps {
  request: OcPendingPermissionRequest
  disabled?: boolean
  submitting?: boolean
  /** Total queued asks for this session (including the one on screen). */
  queueSize?: number
  onReply: (reply: OcPermissionReply, message?: string) => Promise<void>
}

/**
 * Renders OpenCode permission asks from SSE `permission.asked`.
 * Submits via POST `/permission/{requestID}/reply` with once | always | reject.
 *
 * Kept visually loud on purpose: a quiet footer strip is easy to miss while the
 * trajectory shows a spinning tool (todowrite/bash) with no Permission node.
 */
export default function PermissionPromptPanel({
  request,
  disabled,
  submitting,
  queueSize = 1,
  onReply,
}: PermissionPromptPanelProps) {
  const busy = Boolean(disabled || submitting)

  const patternsPreview =
    request.patterns.length > 0 ? request.patterns.slice(0, 6).join('\n') : '(no patterns)'

  const alwaysHint =
    request.always && request.always.length > 0
      ? request.always.slice(0, 4).join(', ')
      : null

  const title =
    request.permission === 'todowrite'
      ? 'Update todo list'
      : request.permission === 'bash'
        ? 'Run shell command'
        : request.permission === 'edit' || request.permission === 'write'
          ? 'Edit files'
          : request.permission || 'permission'

  const moreWaiting = queueSize > 1

  return (
    <div
      role="alertdialog"
      aria-label="Permission required"
      style={{
        borderTop: '2px solid #E5A00D',
        background: 'linear-gradient(180deg, #FFF8E8 0%, #FFFFFF 100%)',
        padding: '14px 16px',
        flexShrink: 0,
        boxShadow: '0 -6px 18px rgba(180, 120, 0, 0.12)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            background: '#F5C518',
            color: '#5C4200',
            fontSize: 13,
            fontWeight: 800,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          !
        </span>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#5C4200' }}>
          Permission required
        </div>
        {moreWaiting ? (
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: '#8A6500',
              background: '#FFE9A8',
              borderRadius: 999,
              padding: '2px 8px',
            }}
          >
            1 / {queueSize}
          </div>
        ) : null}
        <div
          style={{
            marginLeft: 'auto',
            fontSize: 10,
            color: '#A67C00',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          }}
        >
          {request.permission}
        </div>
      </div>

      <div
        style={{
          border: '1px solid #F0D48A',
          borderRadius: 8,
          padding: '10px 12px',
          background: '#FFFFFF',
          marginBottom: 10,
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: '#333', marginBottom: 4 }}>
          {title}
        </div>
        <pre
          style={{
            margin: 0,
            fontSize: 11,
            color: '#444',
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            maxHeight: 120,
            overflow: 'auto',
          }}
        >
          {patternsPreview}
        </pre>
        {request.patterns.length > 6 ? (
          <div style={{ fontSize: 10, color: '#999', marginTop: 4 }}>
            +{request.patterns.length - 6} more
          </div>
        ) : null}
        {alwaysHint ? (
          <div style={{ fontSize: 10, color: '#888', marginTop: 8 }}>
            “Always” would also allow: {alwaysHint}
          </div>
        ) : null}
        {moreWaiting ? (
          <div style={{ fontSize: 10, color: '#8A6500', marginTop: 8 }}>
            {queueSize - 1} more permission{queueSize - 1 === 1 ? '' : 's'} waiting after this one.
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onReply('reject')}
          style={btnStyle(busy, 'ghost')}
        >
          Reject
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onReply('always')}
          style={btnStyle(busy, 'secondary')}
        >
          Always allow
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onReply('once')}
          style={btnStyle(busy, 'primary')}
        >
          {submitting ? 'Sending…' : 'Allow once'}
        </button>
      </div>
    </div>
  )
}

function btnStyle(
  busy: boolean,
  variant: 'primary' | 'secondary' | 'ghost',
): CSSProperties {
  const base: CSSProperties = {
    fontSize: 12,
    padding: '7px 14px',
    borderRadius: 6,
    cursor: busy ? 'not-allowed' : 'pointer',
    opacity: busy ? 0.7 : 1,
    fontWeight: 600,
  }
  if (variant === 'primary') {
    return {
      ...base,
      border: 'none',
      background: busy ? '#C4B5D8' : '#1A1A1A',
      color: '#FFF',
    }
  }
  if (variant === 'secondary') {
    return {
      ...base,
      border: '1px solid #E0E0E0',
      background: '#FFF',
      color: '#333',
    }
  }
  return {
    ...base,
    border: '1px solid #E0E0E0',
    background: '#FFF',
    color: '#666',
    fontWeight: 500,
  }
}
