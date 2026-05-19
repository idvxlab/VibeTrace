import type { OcSession } from '../types/opencode'
import type { MemoryWorkerIngestResult } from '../services/memoryWorkerApi'

/** Must match memory_worker/server.py MW_SESSION_TITLE_PREFIX */
export const MEMORY_WORKER_SESSION_TITLE_PREFIX = '[mw-internal]'

const BLOCKLIST_LS_KEY = 'vibetrace:mw-internal-session-ids'

const blocklist = new Set<string>()

function loadBlocklistFromStorage(): void {
  try {
    const raw = window.localStorage.getItem(BLOCKLIST_LS_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return
    for (const id of parsed) {
      if (typeof id === 'string' && id.trim()) blocklist.add(id.trim())
    }
  } catch {
    /* ignore */
  }
}

function persistBlocklist(): void {
  try {
    window.localStorage.setItem(BLOCKLIST_LS_KEY, JSON.stringify([...blocklist]))
  } catch {
    /* ignore */
  }
}

loadBlocklistFromStorage()

export function isMemoryWorkerInternalSession(session: Pick<OcSession, 'title'> | null | undefined): boolean {
  const title = (session?.title ?? '').trim()
  return title.startsWith(MEMORY_WORKER_SESSION_TITLE_PREFIX)
}

export function isMemoryWorkerInternalSessionId(sessionId: string): boolean {
  return blocklist.has(sessionId)
}

export function shouldSkipTraceIngestForSession(
  sessionId: string,
  session: Pick<OcSession, 'title'> | null | undefined,
): boolean {
  if (isMemoryWorkerInternalSessionId(sessionId)) return true
  return isMemoryWorkerInternalSession(session)
}

export function registerMemoryWorkerInternalSessionIds(ids: Iterable<string>): void {
  let changed = false
  for (const id of ids) {
    const trimmed = id.trim()
    if (!trimmed || blocklist.has(trimmed)) continue
    blocklist.add(trimmed)
    changed = true
  }
  if (changed) persistBlocklist()
}

export function collectInternalSessionIdsFromIngest(result: MemoryWorkerIngestResult): string[] {
  const ids: string[] = []
  const analyzerId = typeof result.analyzerSessionID === 'string' ? result.analyzerSessionID.trim() : ''
  if (analyzerId) ids.push(analyzerId)
  const writerId = typeof result.writerSessionID === 'string' ? result.writerSessionID.trim() : ''
  if (writerId) ids.push(writerId)
  const writerResults = result.writerResults
  if (Array.isArray(writerResults)) {
    for (const item of writerResults) {
      if (!item || typeof item !== 'object') continue
      const resultObj = (item as { result?: unknown }).result
      if (!resultObj || typeof resultObj !== 'object') continue
      const oc = (resultObj as { opencodeSession?: unknown }).opencodeSession
      if (!oc || typeof oc !== 'object') continue
      const sid = (oc as { id?: unknown }).id
      if (typeof sid === 'string' && sid.trim()) ids.push(sid.trim())
    }
  }
  return ids
}
