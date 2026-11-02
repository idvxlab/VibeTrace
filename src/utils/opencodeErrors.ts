import type { OcMessage } from '../types/opencode'

/** Read user-facing messages only; never dump provider headers or request bodies. */
export function openCodeErrorMessage(error: unknown): string | null {
  if (typeof error === 'string') {
    const text = error.trim()
    if (!text) return null
    if (/^[{[]/.test(text)) {
      try { return openCodeErrorMessage(JSON.parse(text)) } catch { /* Plain provider text. */ }
    }
    return text
  }
  if (!error || typeof error !== 'object') return null
  const value = error as Record<string, unknown>
  if (value.name === 'MessageAbortedError' || value.name === 'AbortError') return null
  const data = value.data as Record<string, unknown> | undefined
  for (const candidate of [data?.message, value.message, value.error, data?.error, data?.responseBody]) {
    const message = openCodeErrorMessage(candidate)
    if (message) return message
  }
  return typeof value.name === 'string' ? value.name : null
}

export function sessionFailureFromEvent(event: unknown): { sessionID: string; message: string } | null {
  if (!event || typeof event !== 'object') return null
  const root = event as Record<string, any>
  const payload = root.payload ?? root
  if (payload.type !== 'session.error' && payload.type !== 'message.updated') return null
  const props = payload.properties ?? payload.data ?? payload
  const info = props.info ?? props.message?.info
  const sessionID = props.sessionID ?? props.sessionId ?? info?.sessionID ?? payload.sessionID
  const error = props.error ?? info?.error
  const message = openCodeErrorMessage(error)
  // An internal/background session's failure must never be attributed to the active chat.
  return typeof sessionID === 'string' && sessionID && message ? { sessionID, message } : null
}

export function latestMessageError(messages: OcMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (info.role === 'user') return null
    if (info.role === 'assistant') return openCodeErrorMessage(info.error)
  }
  return null
}

export interface SessionRetry {
  message: string
  attempt: number
  next: number
}

/** Retry is a live session status, not a completed assistant failure. */
export function sessionRetryFromEvent(event: unknown): { sessionID: string; retry: SessionRetry | null } | null {
  if (!event || typeof event !== 'object') return null
  const root = event as Record<string, any>
  const payload = root.payload ?? root
  if (payload.type !== 'session.status') return null
  const props = payload.properties ?? payload.data ?? payload
  const sessionID = props.sessionID ?? props.sessionId
  const status = props.status
  if (typeof sessionID !== 'string' || !sessionID || !status) return null
  if (status.type === 'busy' || status.type === 'idle') return { sessionID, retry: null }
  if (status.type !== 'retry' || typeof status.message !== 'string' ||
      !Number.isFinite(status.attempt) || !Number.isFinite(status.next)) return null
  return { sessionID, retry: { message: status.message, attempt: status.attempt, next: status.next } }
}

export function sessionRetryMessage(retry: SessionRetry, now = Date.now()): string {
  return `${retry.message}\nRetrying in ${Math.max(0, Math.ceil((retry.next - now) / 1000))}s - attempt ${retry.attempt}`
}
