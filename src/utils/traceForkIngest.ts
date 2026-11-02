import type { OcSession } from '../types/opencode'
import type { TraceForkMeta } from '../types/trace'
import { getForkPanelSnapshotBundle } from './forkPanelSnapshot'

export type { TraceForkMeta as ForkIngestMeta }

/**
 * Resolve fork metadata for the current ingest session.
 * The snapshot lives in browser storage, so this lookup must stay on the frontend.
 */
export function resolveForkIngestMeta(
  sessionId: string,
  sessions: OcSession[],
): TraceForkMeta | null {
  // Case A: current session IS the forked child; snapshot was saved on it at fork time.
  const bundle = getForkPanelSnapshotBundle(sessionId)
  if (bundle) {
    return {
      forkAnchorMessageId: bundle.forkAnchorMessageId,
      forkAnchorPartId: bundle.forkAnchorPartId,
      sourceParentSessionId: bundle.sourceParentSessionId,
      forkedSessionId: sessionId,
    }
  }

  // Case B: current session IS the original parent; look for a child that forked from it.
  for (const child of sessions) {
    if (child.parentID !== sessionId) continue
    const childBundle = getForkPanelSnapshotBundle(child.id)
    if (childBundle?.sourceParentSessionId === sessionId) {
      return {
        forkAnchorMessageId: childBundle.forkAnchorMessageId,
        forkAnchorPartId: childBundle.forkAnchorPartId,
        sourceParentSessionId: sessionId,
        forkedSessionId: child.id,
      }
    }
  }

  return null
}
