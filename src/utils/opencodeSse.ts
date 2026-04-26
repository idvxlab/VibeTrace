import type { OcSseActionEvent } from '../types/opencode'

/**
 * 从 `/global/event` 解析与动作相关的事件。
 * OpenCode 常见形态：`{ directory, payload: { type, sessionID, ... } }` 或扁平字段。
 */
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
