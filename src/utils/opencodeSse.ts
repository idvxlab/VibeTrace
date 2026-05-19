import type { OcSseActionEvent } from '../types/opencode'

/**
 * 从 `/global/event` 的单条事件上解析 sessionID（兼容 payload.properties / 顶层字段）。
 * 用于 `message.part.delta` 等对高频事件做按会话的节流刷新。
 * OpenCode 常见形态：`{ directory, payload: { type, sessionID, ... } }` 或扁平字段。
 */
export function sseSessionIdFromEvent(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const payload = (o.payload as Record<string, unknown> | undefined) ?? o
  const props = payload.properties
  if (props && typeof props === 'object') {
    const pr = props as { sessionID?: unknown; sessionId?: unknown }
    if (typeof pr.sessionID === 'string') return pr.sessionID
    if (typeof pr.sessionId === 'string') return pr.sessionId
  }
  if (typeof payload.sessionID === 'string') return payload.sessionID
  if (typeof payload.sessionId === 'string') return payload.sessionId
  return extractSessionId(payload)
}

export function parseActionRelatedSseEvent(raw: unknown): OcSseActionEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const payload = (o.payload as Record<string, unknown> | undefined) ?? o
  const type = (payload.type as string) ?? (o.type as string)
  /** 与 OpenCode Bus 对齐：权限常见为 permission.asked；部分版本/插件为 permission.updated */
  const isPermission =
    type === 'permission.asked' || type === 'permission.updated'
  const isCompaction = type === 'session.compacted'
  if (!isPermission && !isCompaction) return null

  const sessionID =
    (payload.sessionID as string | undefined) ??
    (payload.sessionId as string | undefined) ??
    (o.sessionID as string | undefined) ??
    extractSessionId(payload)

  const time = extractTime(payload, o)

  return {
    type: isPermission ? 'permission.asked' : 'session.compacted',
    sessionID,
    time,
    raw,
  }
}

function extractSessionId(payload: Record<string, unknown>): string | undefined {
  const session = payload.session
  if (session && typeof session === 'object' && 'id' in session) {
    const id = (session as { id?: string }).id
    if (typeof id === 'string') return id
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
  return Date.now()
}

export function eventBelongsToSession(ev: OcSseActionEvent, sessionId: string): boolean {
  if (!sessionId) return false
  if (!ev.sessionID) return true
  return ev.sessionID === sessionId
}
