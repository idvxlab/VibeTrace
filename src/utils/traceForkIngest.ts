import { getMessages } from '../services/opencodeApi'
import type { OcMessage, OcSession } from '../types/opencode'
import type {
  SessionTraceBundle,
  TraceForkComparison,
  TraceForkMeta,
  TraceSessionInfo,
} from '../types/trace'
import { getForkPanelSnapshotBundle } from './forkPanelSnapshot'
import {
  buildTurnTrace,
  fetchChildMessagesForTurn,
  findTurnEndsFromAnchor,
  mergeChildMessageMapsPublic,
  sliceMessagesForTurn,
} from './traceExtraction'

export type { TraceForkMeta as ForkIngestMeta }

function sessionInfo(
  session: Pick<OcSession, 'id' | 'title' | 'directory'> | undefined,
  fallbackId: string,
): TraceSessionInfo {
  return {
    id: session?.id ?? fallbackId,
    title: session?.title,
    directory: session?.directory,
  }
}

/**
 * Resolve fork metadata for the current ingest session.
 * Looks for a stored `ForkPanelSnapshotBundle` on this session, or on a child session whose
 * parent matches the current session.
 */
export function resolveForkIngestMeta(
  sessionId: string,
  sessions: OcSession[],
): TraceForkMeta | null {
  // Case A: current session IS the forked child — snapshot was saved on it at fork time
  const bundle = getForkPanelSnapshotBundle(sessionId)
  if (bundle) {
    return {
      forkAnchorMessageId: bundle.forkAnchorMessageId,
      forkAnchorPartId: bundle.forkAnchorPartId,
      sourceParentSessionId: bundle.sourceParentSessionId,
      forkedSessionId: sessionId,
    }
  }

  // Case B: current session IS the original parent — look for a child that forked from it
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

/**
 * Build turns from parent-session messages starting at the anchor.
 * Collects: the turn containing `forkAnchorMessageId` + up to 3 subsequent turns (max 4 total).
 * Chronological order (oldest first).
 */
async function buildSourceTurns(
  parentMessages: OcMessage[],
  anchorMessageId: string,
  session: Pick<OcSession, 'id' | 'title' | 'directory'> | undefined,
  nowMs: number,
): Promise<import('../types/trace').TurnTrace[]> {
  const stopIds = findTurnEndsFromAnchor(parentMessages, anchorMessageId, 3)
  if (stopIds.length === 0) return []

  // Pre-fetch child-session messages for all relevant turns in one pass
  const childMaps = await Promise.all(
    stopIds.map(async (endId) => {
      const slice = sliceMessagesForTurn(parentMessages, endId)
      if (!slice?.length) return {}
      return fetchChildMessagesForTurn(slice, session?.directory)
    }),
  )
  const childMessagesBySessionId = mergeChildMessageMapsPublic(...childMaps)

  const turns = stopIds
    .map((endId) =>
      buildTurnTrace({
        messages: parentMessages,
        endAssistantMessageId: endId,
        session,
        nowMs,
        childMessagesBySessionId,
      }),
    )
    .filter((t): t is import('../types/trace').TurnTrace => t !== null)

  // stopIds are already chronological (findAssistantStopTurnEndIds → oldest first)
  return turns
}

/**
 * Attach `fork` payload to an already-built `SessionTraceBundle`.
 * Pulls the source (original/parent) session's messages, finds the anchor turn + up to 3 after,
 * and attaches them as `fork.sourceTurns`.
 * Returns the trace unchanged when the anchor cannot be found.
 */
export async function attachForkPayloadToSessionTrace(args: {
  trace: SessionTraceBundle
  meta: TraceForkMeta
  sessions: OcSession[]
  triggeringSessionId: string
  triggeringMessages: OcMessage[]
  nowMs?: number
}): Promise<SessionTraceBundle> {
  const { trace, meta, sessions, triggeringSessionId, triggeringMessages } = args
  if (!meta.forkAnchorMessageId.trim()) return trace

  const nowMs = args.nowMs ?? Date.now()
  const parentSession = sessions.find((s) => s.id === meta.sourceParentSessionId)

  // If the triggering session is the parent, reuse already-fetched messages
  const parentMessages =
    meta.sourceParentSessionId === triggeringSessionId
      ? triggeringMessages
      : await getMessages(
          meta.sourceParentSessionId,
          'fork trace · parent session',
          parentSession?.directory,
        )

  const sourceTurns = await buildSourceTurns(
    parentMessages,
    meta.forkAnchorMessageId,
    parentSession,
    nowMs,
  )
  if (sourceTurns.length === 0) return trace

  const fork: TraceForkComparison = {
    meta,
    session: sessionInfo(parentSession, meta.sourceParentSessionId),
    sourceTurns,
  }

  return { ...trace, fork }
}
