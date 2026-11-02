import type { OcPendingPermissionRequest, OcSseActionEvent } from '../types/opencode'
import { normalizePermissionRequest } from '../services/opencodeApi'

/**
 * Parse sessionID from a single `/global/event` payload (supports payload.properties / top-level fields).
 * Used to throttle per-session refresh for high-frequency events like `message.part.delta`.
 * Common OpenCode shapes: `{ directory, payload: { type, sessionID, ... } }` or flat fields.
 */
export function sseSessionIdFromEvent(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const payload = (o.payload as Record<string, unknown> | undefined) ?? o
  const bags: Record<string, unknown>[] = [payload]
  for (const key of ['properties', 'data', 'request'] as const) {
    const nested = payload[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      bags.push(nested as Record<string, unknown>)
    }
  }
  for (const bag of bags) {
    if (typeof bag.sessionID === 'string') return bag.sessionID
    if (typeof bag.sessionId === 'string') return bag.sessionId
  }
  return extractSessionId(payload)
}

/** Resolve bus event type from GlobalEvent / flat BusEvent / SSE `event:` name fallback. */
export function sseEventTypeFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const payload = (o.payload as Record<string, unknown> | undefined) ?? o
  if (typeof payload.type === 'string' && payload.type.trim()) return payload.type.trim()
  if (typeof o.type === 'string' && o.type.trim()) return o.type.trim()
  if (typeof o.__sseEventName === 'string' && o.__sseEventName.trim()) {
    const name = o.__sseEventName.trim()
    if (name && name !== 'message') return name
  }
  return undefined
}

export function isPermissionAskEventType(type: string | undefined): boolean {
  if (!type) return false
  return (
    type === 'permission.asked' ||
    type === 'permission.updated' ||
    type === 'permission.v2.asked' ||
    type === 'permission.v2.updated'
  )
}

export function isPermissionReplyEventType(type: string | undefined): boolean {
  if (!type) return false
  return (
    type === 'permission.replied' ||
    type === 'permission.v2.replied' ||
    type === 'permission.rejected' ||
    type === 'permission.v2.rejected'
  )
}

export function isCompactionEventType(type: string | undefined): boolean {
  if (!type) return false
  return (
    type === 'session.compacted' ||
    type === 'session.next.compaction.started' ||
    type === 'session.next.compaction.ended' ||
    type === 'session.next.compaction.delta'
  )
}

export function parseActionRelatedSseEvent(raw: unknown): OcSseActionEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const payload = (o.payload as Record<string, unknown> | undefined) ?? o
  const type = sseEventTypeFromRaw(raw)
  const isPermission = isPermissionAskEventType(type)
  const isCompaction = isCompactionEventType(type)
  if (!isPermission && !isCompaction) return null

  const time = extractTime(payload, o)
  const rootDir = typeof o.directory === 'string' ? o.directory : undefined

  if (isPermission) {
    // OpenCode 1.18+ durable events put the ask under `data`; older bus events use `properties`.
    const props =
      (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
        ? payload.data
        : payload.properties && typeof payload.properties === 'object'
          ? payload.properties
          : payload) as Record<string, unknown>
    const sessionFromEnvelope =
      (typeof props.sessionID === 'string' && props.sessionID) ||
      (typeof props.sessionId === 'string' && props.sessionId) ||
      (typeof payload.sessionID === 'string' && payload.sessionID) ||
      (typeof payload.sessionId === 'string' && payload.sessionId) ||
      (typeof o.sessionID === 'string' && o.sessionID) ||
      extractSessionId(payload)
    const permission = normalizePermissionRequest(props, {
      directory: rootDir,
      askedAt: time,
      sessionID: sessionFromEnvelope,
    }) ?? normalizePermissionRequest(payload, {
      directory: rootDir,
      askedAt: time,
      sessionID: sessionFromEnvelope,
    })
    const sessionID = permission?.sessionID ?? sessionFromEnvelope

    return {
      type: 'permission.asked',
      sessionID,
      time,
      permission: permission ?? undefined,
      raw,
    }
  }

  const props =
    payload.properties && typeof payload.properties === 'object'
      ? (payload.properties as Record<string, unknown>)
      : undefined
  const sessionID =
    (typeof props?.sessionID === 'string' && props.sessionID) ||
    (typeof props?.sessionId === 'string' && props.sessionId) ||
    (typeof payload.sessionID === 'string' ? payload.sessionID : undefined) ||
    (typeof payload.sessionId === 'string' ? payload.sessionId : undefined) ||
    (typeof o.sessionID === 'string' ? o.sessionID : undefined) ||
    extractSessionId(payload)

  const status =
    type === 'session.next.compaction.started'
      ? ('running' as const)
      : type === 'session.next.compaction.delta'
        ? ('running' as const)
        : ('completed' as const)

  const detailText =
    typeof props?.text === 'string' && props.text.trim()
      ? props.text.trim().slice(0, 120)
      : typeof props?.reason === 'string' && props.reason.trim()
        ? `compaction · ${props.reason}`
        : type ?? 'session.compacted'

  return {
    type: type === 'session.compacted' ? 'session.compacted' : type!,
    sessionID,
    time,
    compaction: { status, detail: detailText },
    raw,
  }
}

/** Build a pending-permission object from a raw SSE event (null if not a permission ask). */
export function parsePendingPermissionFromSse(
  raw: unknown,
): OcPendingPermissionRequest | null {
  const parsed = parseActionRelatedSseEvent(raw)
  if (!parsed || parsed.type !== 'permission.asked') return null
  if (parsed.permission) return parsed.permission
  return null
}

function extractSessionId(payload: Record<string, unknown>): string | undefined {
  const session = payload.session
  if (session && typeof session === 'object' && 'id' in session) {
    const id = (session as { id?: string }).id
    if (typeof id === 'string') return id
  }
  const part = payload.part
  if (part && typeof part === 'object') {
    const sid = (part as { sessionID?: unknown; sessionId?: unknown }).sessionID
    if (typeof sid === 'string') return sid
    const sid2 = (part as { sessionId?: unknown }).sessionId
    if (typeof sid2 === 'string') return sid2
  }
  return undefined
}

function extractTime(payload: Record<string, unknown>, root: Record<string, unknown>): number {
  const t = payload.time
  if (t && typeof t === 'object' && 'created' in t && typeof (t as { created: unknown }).created === 'number') {
    return (t as { created: number }).created
  }
  if (typeof payload.timestamp === 'number') return payload.timestamp
  if (typeof root.timestamp === 'number') return root.timestamp
  const props = payload.properties
  if (props && typeof props === 'object') {
    const askedAt = (props as { askedAt?: unknown }).askedAt
    if (typeof askedAt === 'number' && Number.isFinite(askedAt)) return askedAt
  }
  return Date.now()
}

export function eventBelongsToSession(ev: OcSseActionEvent, sessionId: string): boolean {
  if (!sessionId) return false
  if (!ev.sessionID) return true
  return ev.sessionID === sessionId
}
