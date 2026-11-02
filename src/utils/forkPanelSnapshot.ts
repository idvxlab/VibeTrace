import type { FlowEndSummary } from '../components/ActionFlowVisualization'
import type { MappedAction, OcMessage } from '../types/opencode'
import type { AssistantSubtask } from './subtaskGrouping'
import {
  applyParallelLayoutFromCalls,
  buildChildSessionBandMap,
  buildChildSessionBranchActions,
  buildMappedActionsFromMessages,
  collectTaskChildDescriptors,
  detectParallelCallMapping,
} from './actionMapping'
import { mergeMessagesForActionTooltipLookup } from './actionTooltipMapping'
import { getMessages } from '../services/opencodeApi'
import { STORAGE_KEYS } from '../config/storageKeys'
import {
  buildSubtaskCardMetricsFromMessages,
  type SubtaskCardMetrics,
} from './subtaskMetrics'

/** Passed when forking from a SubtaskCard action menu */
export type ForkFromActionContext = {
  subtaskId: string
  subtaskDisplayIndex: number
  assistantMessageIndices: number[]
}

export type ForkPanelSubtaskSnapshot = {
  subtaskId: string
  displayIndex: number
  flowActions: (MappedAction & { row: number })[]
  tooltipMessages: OcMessage[]
}

/** v1: legacy — snapshot for every subtask (deprecated) */
type ForkPanelSnapshotBundleV1 = {
  version: 1
  forkPrompt: string
  forkAnchorMessageId: string
  sourceParentSessionId: string
  subtasks: ForkPanelSubtaskSnapshot[]
}

/** v2: only the subtask where fork was triggered (does not store the post-fork user message text) */
export type ForkPanelSnapshotBundle = {
  version: 2
  forkAnchorMessageId: string
  /** Optional anchor at part granularity; otherwise we take the last mapped action on forkAnchorMessageId */
  forkAnchorPartId?: string
  sourceParentSessionId: string
  forkOriginSubtaskId: string
  forkOriginDisplayIndex: number
  snapshot: ForkPanelSubtaskSnapshot
  /** Trace summary + metrics captured from the source session at fork time (ghost rail terminator). */
  originFlowEndSummary?: FlowEndSummary
}

function storageKey(sessionId: string): string {
  return `${STORAGE_KEYS.forkPanelPrefix}${sessionId}`
}

export function saveForkPanelSnapshotBundle(sessionId: string, bundle: ForkPanelSnapshotBundle): void {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(bundle))
  } catch {
    // quota / private mode
  }
}

function normalizeBundle(raw: unknown): ForkPanelSnapshotBundle | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.version === 2 && o.snapshot && typeof o.snapshot === 'object') {
    const s = o.snapshot as ForkPanelSubtaskSnapshot
    if (!Array.isArray(s.flowActions)) return null
    return raw as ForkPanelSnapshotBundle
  }
  if (o.version === 1 && Array.isArray(o.subtasks)) {
    const v1 = raw as ForkPanelSnapshotBundleV1
    if (v1.subtasks.length === 0) return null
    const first = v1.subtasks[0]!
    return {
      version: 2,
      forkAnchorMessageId: v1.forkAnchorMessageId,
      forkAnchorPartId: undefined,
      sourceParentSessionId: v1.sourceParentSessionId,
      forkOriginSubtaskId: first.subtaskId,
      forkOriginDisplayIndex: first.displayIndex,
      snapshot: first,
    }
  }
  return null
}

export function getForkPanelSnapshotBundle(sessionId: string): ForkPanelSnapshotBundle | null {
  try {
    const raw = localStorage.getItem(storageKey(sessionId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    return normalizeBundle(parsed)
  } catch {
    return null
  }
}

/**
 * Metrics for the shared pre-fork prefix only (actions up to and including the fork anchor).
 * Used to top-up the forked panel strip / filter so they include history shown from the snapshot.
 */
export function buildForkPrefixMetricsFromSnapshot(
  bundle: ForkPanelSnapshotBundle,
  nowMs: number = Date.now(),
): SubtaskCardMetrics | null {
  const oldActions = bundle.snapshot.flowActions
  const anchorMessageId = bundle.forkAnchorMessageId
  const anchorPartId = bundle.forkAnchorPartId
  const oldAnchorIdx = oldActions.findIndex(
    (a) =>
      a.messageID === anchorMessageId && (anchorPartId ? a.partId === anchorPartId : true),
  )
  if (oldAnchorIdx < 0) return null

  const prefixActions = oldActions.slice(0, oldAnchorIdx + 1)
  const parentMsgIds = new Set(
    prefixActions
      .filter((a) => a.source !== 'child-session' && a.messageID)
      .map((a) => a.messageID as string),
  )
  const childMsgIds = new Set(
    prefixActions
      .filter((a) => a.source === 'child-session' && a.messageID)
      .map((a) => a.messageID as string),
  )
  const tooltip = bundle.snapshot.tooltipMessages
  const assistantMessages = tooltip.filter(
    (m) => m.info.role === 'assistant' && parentMsgIds.has(m.info.id),
  )
  const additionalMessages = tooltip.filter((m) => childMsgIds.has(m.info.id))
  if (assistantMessages.length === 0 && additionalMessages.length === 0) return null

  return buildSubtaskCardMetricsFromMessages({
    title: bundle.snapshot.subtaskId,
    assistantMessages,
    additionalMessages,
    nowMs,
  })
}

export async function buildFlowSnapshotForSubtask(
  subtask: AssistantSubtask,
  messages: OcMessage[],
  sessionDirectory: string | undefined,
  nowMs: number,
): Promise<{
  flowActions: (MappedAction & { row: number })[]
  tooltipMessages: OcMessage[]
}> {
  const segmentMessages = subtask.assistantMessageIndices
    .map((i) => messages[i])
    .filter((m): m is OcMessage => m != null)

  const parentFlowActions = buildMappedActionsFromMessages(segmentMessages, { nowMs })
  const taskDescriptors = collectTaskChildDescriptors(segmentMessages)
  const parallelByCallId = detectParallelCallMapping(segmentMessages, nowMs)
  const childSessionBandMap = buildChildSessionBandMap(taskDescriptors, parallelByCallId)

  const childBranchMessages: OcMessage[] = []
  const childBranchActions: (MappedAction & { row: number })[] = []

  for (const d of taskDescriptors) {
    try {
      const msgs = await getMessages(
        d.childSessionID,
        `fork panel snapshot · ${d.callID.slice(0, 12)}`,
        sessionDirectory,
      )
      childBranchMessages.push(...msgs)
      const branchOpts = {
        branchChildSessionID: d.childSessionID,
        parentTaskCallID: d.callID,
        anchorSortTime: d.anchorSortTime,
        sessionBandIndex: childSessionBandMap.get(d.childSessionID) ?? 1,
        nowMs,
      }
      childBranchActions.push(...buildChildSessionBranchActions(msgs, branchOpts))
    } catch {
      /* keep parent segment only */
    }
  }

  const merged = [...parentFlowActions, ...childBranchActions].sort((a, b) => a.sortTime - b.sortTime)
  const flowActions = applyParallelLayoutFromCalls(merged, parallelByCallId)
  const tooltipMessages = mergeMessagesForActionTooltipLookup(segmentMessages, childBranchMessages)
  return { flowActions, tooltipMessages }
}

export async function buildForkPanelSnapshotBundle(opts: {
  messages: OcMessage[]
  visibleSubtasks: Array<{ subtask: AssistantSubtask; sourceIndex: number }>
  sessionDirectory: string | undefined
  forkAnchorMessageId: string
  forkAnchorPartId?: string
  sourceParentSessionId: string
  forkCtx: ForkFromActionContext
  originFlowEndSummary?: FlowEndSummary
}): Promise<ForkPanelSnapshotBundle> {
  const nowMs = Date.now()
  const pair =
    opts.visibleSubtasks.find(({ subtask }) => subtask.subtask_id === opts.forkCtx.subtaskId) ??
    opts.visibleSubtasks.find(({ sourceIndex }) => sourceIndex === opts.forkCtx.subtaskDisplayIndex)

  if (!pair) {
    throw new Error('Fork: could not resolve subtask card for snapshot')
  }

  const { flowActions, tooltipMessages } = await buildFlowSnapshotForSubtask(
    pair.subtask,
    opts.messages,
    opts.sessionDirectory,
    nowMs,
  )

  const snapshot: ForkPanelSubtaskSnapshot = {
    subtaskId: pair.subtask.subtask_id,
    displayIndex: pair.sourceIndex,
    flowActions,
    tooltipMessages,
  }

  return {
    version: 2,
    forkAnchorMessageId: opts.forkAnchorMessageId,
    ...(opts.forkAnchorPartId ? { forkAnchorPartId: opts.forkAnchorPartId } : {}),
    sourceParentSessionId: opts.sourceParentSessionId,
    forkOriginSubtaskId: pair.subtask.subtask_id,
    forkOriginDisplayIndex: pair.sourceIndex,
    snapshot,
    ...(opts.originFlowEndSummary ? { originFlowEndSummary: opts.originFlowEndSummary } : {}),
  }
}
