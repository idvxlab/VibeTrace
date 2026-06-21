import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { MappedAction, OcMessage } from '../types/opencode'
import type { AssistantSubtask } from '../utils/subtaskGrouping'
import { buildSubtaskCardMetrics, formatDurationMs, formatSubtaskCostDisplay } from '../utils/subtaskMetrics'
import {
  applyParallelLayoutFromCalls,
  buildChildSessionBandMap,
  buildChildSessionBranchActions,
  buildMappedActionsFromMessages,
  collectTaskChildDescriptors,
  detectParallelCallMapping,
  extractChildSessionIdFromToolPart,
  isSubagentToolName,
} from '../utils/actionMapping'
import type { ForkFromActionContext, ForkPanelSnapshotBundle } from '../utils/forkPanelSnapshot'
import { mergeMessagesForActionTooltipLookup } from '../utils/actionTooltipMapping'
import ActionFlowVisualization from './ActionFlowVisualization'
import {
  type ActionTypePaletteId,
} from '../styles/actionTypePalettes'
import { getMessages } from '../services/opencodeApi'
import { actionKey } from '../utils/actionKey'
import type { MemoryWorkerErrorDiagnosis } from '../services/memoryWorkerApi'

const fontSans =
  "'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"

/** Minimum card height; grows with richer content such as fork comparison */
const CARD_MIN_HEIGHT = 220
/** Cap trace viewport at ~two stacked subtask cards — lanes grow until this limit, then scroll */
const FLOW_VIEWPORT_MAX_HEIGHT = CARD_MIN_HEIGHT * 2
const LONG_RUNNING_MS = 60_000

interface SubtaskCardProps {
  subtask: AssistantSubtask
  messages: OcMessage[]
  displayIndex: number
  /** DOM index for connectors/scroll — must match `linkedSubtaskIndex` in App */
  cardIndex?: number
  isLinked?: boolean
  onSelectSubtask?: () => void
  onForkFromAction?: (action: MappedAction & { row: number }, ctx: ForkFromActionContext) => void
  onAnalyzeFromAction?: (action: MappedAction & { row: number }) => void
  /** Required when fetching child sessions with multi-directory OpenCode */
  sessionDirectory?: string
  /** Forked session: local read-only snapshot for comparison (not in model context) */
  forkPanelSnapshotBundle?: ForkPanelSnapshotBundle | null
  /** Selected action type — highlight same type in ActionFlow (reserved; no UI entry yet) */
  selectedActionType?: string | null
  /** Selected action key — takes precedence over `selectedActionType` */
  selectedActionKey?: string | null
  /** When another subtask holds the selection, dim every action in this card */
  otherSubtaskHasSelection?: boolean
  /** ActionFlow rect click */
  onSelectActionFromFlow?: (actionKey: string | null) => void
  /** Shared coloring mode controlled by parent subtask panel */
  colorBy: ColorByMode
  onColorByChange: (mode: ColorByMode) => void
  /** Shared action-type palette from parent panel */
  actionTypePaletteId: ActionTypePaletteId
  /** Auto-generated root-cause analysis for failed traces; absent keeps the original end tooltip unchanged. */
  errorDiagnosis?: MemoryWorkerErrorDiagnosis
}

type ColorByMode = 'tokens' | 'type'
type FilterMode = 'duration' | 'tokens'

function MetricBox({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div
      style={{
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '3px 4px',
        minWidth: 0,
        flex: '1 1 0',
        minHeight: 44,
        border: '1px solid #DBDBDB',
        borderRadius: 10,
        background: '#FCFCFC',
      }}
    >
      <div
        className={alert ? 'subtask-time-alert' : undefined}
        style={{
          fontFamily: fontSans,
          fontWeight: 600,
          fontSize: 9,
          lineHeight: '12px',
          textAlign: 'center',
          color: '#5C5C5C',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: fontSans,
          fontWeight: 600,
          fontSize: 13,
          lineHeight: '16px',
          textAlign: 'center',
          color: '#2B2B2B',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </div>
    </div>
  )
}

export default function SubtaskCard({
  subtask,
  messages,
  displayIndex,
  cardIndex,
  isLinked = false,
  onSelectSubtask,
  onForkFromAction,
  onAnalyzeFromAction,
  sessionDirectory,
  forkPanelSnapshotBundle = null,
  selectedActionType = null,
  selectedActionKey = null,
  otherSubtaskHasSelection = false,
  onSelectActionFromFlow,
  colorBy,
  onColorByChange,
  actionTypePaletteId,
  errorDiagnosis,
}: SubtaskCardProps) {
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [actionsDurationOn, setActionsDurationOn] = useState(false)
  const [filterMode, setFilterMode] = useState<FilterMode>('duration')
  /** DOM anchor only — use outer wrapper for fork/scroll */
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [childBranchActions, setChildBranchActions] = useState<(MappedAction & { row: number })[]>([])
  /** Raw child-session messages merged into Changes (write/edit paths) */
  const [childBranchMessages, setChildBranchMessages] = useState<OcMessage[]>([])

  const m = useMemo(
    () =>
      buildSubtaskCardMetrics(subtask, messages, displayIndex, {
        nowMs: nowTick,
        additionalMessages: childBranchMessages,
      }),
    [subtask, messages, displayIndex, nowTick, childBranchMessages],
  )

  /** Leading user indices + assistants in global timeline order */
  const segmentMessages = useMemo((): OcMessage[] => {
    const indices = [
      ...(subtask.userMessageIndices ?? []),
      ...subtask.assistantMessageIndices,
    ].sort((a, b) => a - b)
    return indices
      .map(i => messages[i])
      .filter((msg): msg is OcMessage => msg != null)
  }, [subtask.userMessageIndices, subtask.assistantMessageIndices, messages])

  const parentFlowActions = useMemo(
    () => buildMappedActionsFromMessages(segmentMessages, { nowMs: nowTick }),
    [segmentMessages, nowTick]
  )

  const taskDescriptors = useMemo(
    () => collectTaskChildDescriptors(segmentMessages),
    [segmentMessages]
  )
  const parallelByCallId = useMemo(
    () => detectParallelCallMapping(segmentMessages, nowTick),
    [segmentMessages, nowTick]
  )
  /** Parallel children share one band lane; sequential children still bump by session id order */
  const childSessionBandMap = useMemo(
    () => buildChildSessionBandMap(taskDescriptors, parallelByCallId),
    [taskDescriptors, parallelByCallId]
  )

  const hasRunningTaskWithChild = useMemo(() => {
    return segmentMessages.some((msg) => {
      if (msg.info.role !== 'assistant') return false
      return msg.parts.some((p) => {
        if (p.type !== 'tool' || !isSubagentToolName(p.tool)) return false
        if (p.state?.status !== 'running') return false
        return Boolean(extractChildSessionIdFromToolPart(p))
      })
    })
  }, [segmentMessages])

  const loadChildBranches = useCallback(async () => {
    if (taskDescriptors.length === 0) {
      setChildBranchActions([])
      setChildBranchMessages([])
      return
    }
    const results = await Promise.all(
      taskDescriptors.map(async (d) => {
        try {
          const msgs = await getMessages(
            d.childSessionID,
            `Child session · ${d.callID.slice(0, 12)}`,
            sessionDirectory,
          )
          const branchOpts = {
            branchChildSessionID: d.childSessionID,
            parentTaskCallID: d.callID,
            anchorSortTime: d.anchorSortTime,
            /** Stable lane index per distinct child session: first unique id = 1, second = 2, … */
            sessionBandIndex: childSessionBandMap.get(d.childSessionID) ?? 1,
            nowMs: nowTick,
          }
          const actions = buildChildSessionBranchActions(msgs, branchOpts)
          return { msgs, actions }
        } catch {
          return {
            msgs: [] as OcMessage[],
            actions: [] as (MappedAction & { row: number })[],
          }
        }
      }),
    )
    setChildBranchActions(results.flatMap((r) => r.actions))
    setChildBranchMessages(results.flatMap((r) => r.msgs))
  }, [taskDescriptors, sessionDirectory, childSessionBandMap, nowTick])

  useEffect(() => {
    void loadChildBranches()
  }, [loadChildBranches])

  useEffect(() => {
    if (!hasRunningTaskWithChild) return
    const id = window.setInterval(() => {
      void loadChildBranches()
    }, 3200)
    return () => window.clearInterval(id)
  }, [hasRunningTaskWithChild, loadChildBranches])

  const flowActions = useMemo(() => {
    const merged = [...parentFlowActions, ...childBranchActions].sort((a, b) => a.sortTime - b.sortTime)
    return applyParallelLayoutFromCalls(merged, parallelByCallId)
  }, [parentFlowActions, childBranchActions, parallelByCallId])

  const durationDomain = useMemo(() => {
    const vals = flowActions
      .map((a) => a.durationMs)
      .filter((v): v is number => Number.isFinite(v) && v >= 0)
    if (!vals.length) return null
    return { min: Math.min(...vals), max: Math.max(...vals) }
  }, [flowActions])
  const tokenDomain = useMemo(() => {
    const vals = flowActions
      .map((a) => a.tokenEstimate)
      .filter((v): v is number => Number.isFinite(v) && v >= 0)
    if (!vals.length) return null
    return { min: Math.min(...vals), max: Math.max(...vals) }
  }, [flowActions])
  const [durationHighlightMinMs, setDurationHighlightMinMs] = useState(0)
  const [tokenHighlightMin, setTokenHighlightMin] = useState(0)
  const [filterTouched, setFilterTouched] = useState(false)
  const subtaskSig = useMemo(() => {
    const ids = subtask.assistantMessageIndices
    const first = ids[0] ?? -1
    const last = ids[ids.length - 1] ?? -1
    return `${subtask.subtask_id}:${first}:${last}:${ids.length}`
  }, [subtask.subtask_id, subtask.assistantMessageIndices])
  useEffect(() => {
    setFilterTouched(false)
    setDurationHighlightMinMs(0)
    setTokenHighlightMin(0)
  }, [subtaskSig])
  useEffect(() => {
    if (!durationDomain) {
      setDurationHighlightMinMs(0)
      return
    }
    setDurationHighlightMinMs((prev) => {
      if (prev < durationDomain.min || prev > durationDomain.max) return durationDomain.min
      return prev
    })
  }, [durationDomain])
  useEffect(() => {
    if (!tokenDomain) {
      setTokenHighlightMin(0)
      return
    }
    setTokenHighlightMin((prev) => {
      if (prev < tokenDomain.min || prev > tokenDomain.max) return tokenDomain.min
      return prev
    })
  }, [tokenDomain])
  const durationHighlightStep = useMemo(() => {
    if (!durationDomain) return 1
    return Math.max(1, Math.round((durationDomain.max - durationDomain.min) / 240))
  }, [durationDomain])
  const tokenHighlightStep = useMemo(() => {
    if (!tokenDomain) return 1
    return Math.max(1, Math.round((tokenDomain.max - tokenDomain.min) / 240))
  }, [tokenDomain])
  const activeFilterDomain = filterMode === 'duration' ? durationDomain : tokenDomain
  const activeFilterStep = filterMode === 'duration' ? durationHighlightStep : tokenHighlightStep
  const activeFilterValue = filterMode === 'duration' ? durationHighlightMinMs : tokenHighlightMin
  const effectiveFilterMin = useMemo(() => {
    if (!activeFilterDomain) return 0
    return filterTouched ? activeFilterValue : activeFilterDomain.min
  }, [activeFilterDomain, filterTouched, activeFilterValue])
  const matchedActionCount = useMemo(() => {
    if (filterMode === 'duration') {
      if (!durationDomain) return flowActions.length
      return flowActions.filter(
        (a) => Number.isFinite(a.durationMs) && a.durationMs >= effectiveFilterMin
      ).length
    }
    if (!tokenDomain) return flowActions.length
    return flowActions.filter(
      (a) => Number.isFinite(a.tokenEstimate) && a.tokenEstimate >= effectiveFilterMin
    ).length
  }, [filterMode, flowActions, durationDomain, tokenDomain, effectiveFilterMin])
  const activeFilterMaxLabel = useMemo(() => {
    if (!activeFilterDomain) return ''
    if (filterMode === 'duration') return formatDurationMs(activeFilterDomain.max)
    return `${Math.round(activeFilterDomain.max)} tok`
  }, [filterMode, activeFilterDomain])
  /** Dim only once the slider moves above domain min — default min matches “no filter” */
  const durationHighlightForFlow =
    filterMode === 'duration' &&
    filterTouched &&
    durationDomain != null &&
    durationHighlightMinMs > durationDomain.min
      ? durationHighlightMinMs
      : null
  const tokenHighlightForFlow =
    filterMode === 'tokens' &&
    filterTouched &&
    tokenDomain != null &&
    tokenHighlightMin > tokenDomain.min
      ? tokenHighlightMin
      : null

  /** Matches `mergeMessagesForActionTooltipLookup`: parent segment + fetched child rows */
  const tooltipLookupMessages = useMemo(
    () => mergeMessagesForActionTooltipLookup(segmentMessages, childBranchMessages),
    [segmentMessages, childBranchMessages],
  )

  /**
   * After fork: one SVG merges shared pre-fork prefix + gray ghost after the anchor + the new branch.
   *
   * Fork-pre actions belong to the new OpenCode session context (messages are copied on fork) and already
   * live in `flowActions`. Pre-fork plus the live branch therefore reuse the **same** action objects so
   * treemap, tooltip, and selection state stay consistent. Only post-anchor “hypothetical old branch” steps
   * come from the snapshot ghost stream (absent in the forked session timeline).
   *
   * Routing rules (applied in order):
   *
   * A) Anchor found in THIS subtask AND post-anchor actions exist here:
   *    → Standard merged view. Handles the case where fork prompt reply lands in the same subtask.
   *
   * B) Anchor found in THIS subtask BUT no post-anchor actions exist:
   *    → New branch is in the NEXT subtask (displayIndex + 1). Render this card normally so the
   *      origin copy is not shown twice; the full comparison appears in the next card via Rule C.
   *
   * C) Anchor NOT found AND displayIndex === forkOriginDisplayIndex + 1:
   *    → First post-fork subtask (fork prompt + AI reply). Show full comparison using snapshot as
   *      historical context: snapshot history → ghost → current flowActions as new branch.
   *
   * All other subtasks return null.
   */
  const forkMergedFlow = useMemo(() => {
    if (!forkPanelSnapshotBundle || forkPanelSnapshotBundle.version !== 2) return null
    const b = forkPanelSnapshotBundle
    const anchorMessageId = b.forkAnchorMessageId
    const anchorPartId = b.forkAnchorPartId
    const matchAnchor = (a: MappedAction & { row: number }) =>
      a.messageID === anchorMessageId && (anchorPartId ? a.partId === anchorPartId : true)

    const oldActions = b.snapshot.flowActions
    const oldAnchorIdx = oldActions.findIndex(matchAnchor)
    if (oldAnchorIdx < 0) return null

    const currentAnchorIdx = flowActions.findIndex(matchAnchor)

    let preForkAndAnchor: (MappedAction & { row: number })[]
    let postAnchorCurrent: (MappedAction & { row: number })[]

    if (currentAnchorIdx >= 0) {
      preForkAndAnchor = flowActions.slice(0, currentAnchorIdx + 1)
      postAnchorCurrent = flowActions.slice(currentAnchorIdx + 1)
      /**
       * Rule B: anchor present but no post-fork actions in this card.
       * The fork comparison will be shown in the next subtask card (Rule C).
       */
      if (postAnchorCurrent.length === 0) return null
    } else {
      /**
       * Rule C: first post-fork subtask — show full comparison with snapshot as historical prefix.
       */
      if (displayIndex !== b.forkOriginDisplayIndex + 1) return null
      preForkAndAnchor = oldActions.slice(0, oldAnchorIdx + 1)
      postAnchorCurrent = flowActions
    }

    const anchorActionKey = actionKey(preForkAndAnchor[preForkAndAnchor.length - 1]!)
    const sessionActions = [...preForkAndAnchor, ...postAnchorCurrent].sort(
      (x, y) => x.sortTime - y.sortTime,
    )

    const ghostSuffix = oldActions
      .slice(oldAnchorIdx + 1)
      .map((a) => ({ ...a, forkGhost: true }))

    const newBranch = postAnchorCurrent.map((a) => ({ ...a, forkCompareRow: 2 as const }))

    const merged = [...preForkAndAnchor, ...ghostSuffix, ...newBranch].sort(
      (x, y) => x.sortTime - y.sortTime,
    )
    const mergedTooltips = [...b.snapshot.tooltipMessages, ...tooltipLookupMessages]
    return { merged, mergedTooltips, anchorActionKey, sessionActions }
  }, [forkPanelSnapshotBundle, displayIndex, flowActions, tooltipLookupMessages])
  const hasActiveRunningAction = useMemo(
    () => flowActions.some((a) => a.status === 'running' || a.status === 'pending'),
    [flowActions],
  )
  const hasLongRunningAction = useMemo(
    () =>
      flowActions.some(
        (a) => (a.status === 'running' || a.status === 'pending') && a.durationMs >= LONG_RUNNING_MS,
      ),
    [flowActions],
  )

  useEffect(() => {
    if (!hasActiveRunningAction) return
    /**
     * 2s heartbeat: bumps `parentFlowActions`/`flowActions` references so ActionFlowVisualization’s D3 effect
     * rebuilds (~one visible flash per tick). 1 Hz felt too frantic during streamed generation — 2s balances
     * “live duration” readability with calmer visuals.
     */
    const id = window.setInterval(() => setNowTick(Date.now()), 2000)
    return () => window.clearInterval(id)
  }, [hasActiveRunningAction])

  const durationLabel = formatDurationMs(m.durationMs)
  const changesLabel = String(m.mutatedFileCount)
  /** Hide the golden end capsule while tools are active so tasks don’t look “done” prematurely */
  const showFlowEndNode = !hasActiveRunningAction && flowActions.length > 0

  /**
   * Stabilize `flowEndSummary` identity — inline object literals each render fooled ActionFlowVisualization’s first
   * `useLayoutEffect` into `selectAll('*').remove()`, wiping the SVG whenever clicks/`nowTick` fired.
   */
  const flowEndSummary = useMemo(
    () => ({
      readFileTotalCount: m.readFilesCount,
      readFilePaths: m.readFilePaths,
      globMatchFileCount: m.globMatchFileCount,
      webSearchCount: m.webSearchCallCount,
      webSearchQueries: m.webSearchQueries,
      writeFileCount: m.mutatedFileCount,
      changedFilePaths: m.mutatedFilePaths,
      errorDiagnosis,
    }),
    [
      m.readFilesCount,
      m.readFilePaths,
      m.globMatchFileCount,
      m.webSearchCallCount,
      m.webSearchQueries,
      m.mutatedFileCount,
      m.mutatedFilePaths,
      errorDiagnosis,
    ],
  )

  /** Same memo trick for fork handler identity */
  const handleForkFromActionWrapped = useMemo(() => {
    if (!onForkFromAction) return undefined
    return (act: MappedAction & { row: number }) =>
      onForkFromAction(act, {
        subtaskId: subtask.subtask_id,
        subtaskDisplayIndex: displayIndex,
        assistantMessageIndices: subtask.assistantMessageIndices,
      })
  }, [onForkFromAction, subtask.subtask_id, subtask.assistantMessageIndices, displayIndex])

  const bodyContent = (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontWeight: 600,
            fontSize: 13,
            lineHeight: '18px',
            color: '#2B2B2B',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {m.title}
        </h3>
      </div>

      <div
        onClick={e => e.stopPropagation()}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          gap: '6px 10px',
          width: '100%',
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            flex: '0 1 auto',
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 400, lineHeight: '14px', color: '#2B2B2B' }}>
              Actions duration
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={actionsDurationOn}
              onClick={() => setActionsDurationOn(v => !v)}
              style={{
                width: 26,
                height: 13,
                borderRadius: 80,
                background: actionsDurationOn ? '#2B2B2B' : '#8A8A8A',
                border: 'none',
                padding: 2,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: actionsDurationOn ? 'flex-end' : 'flex-start',
              }}
            >
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: '#FFFFFF',
                  display: 'block',
                  flexShrink: 0,
                }}
              />
            </button>
          </div>
          <div
            style={{
              width: 1,
              height: 14,
              background: '#DBDBDB',
              flexShrink: 0,
            }}
          />
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 400, lineHeight: '14px', color: '#2B2B2B' }}>
              Actions color
            </span>
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                onClick={() => onColorByChange('tokens')}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  fontFamily: fontSans,
                  fontSize: 11,
                  lineHeight: '16px',
                  color: colorBy === 'tokens' ? '#2B2B2B' : '#C6C6C6',
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 3,
                    boxSizing: 'border-box',
                    background: colorBy === 'tokens' ? '#C6C6C6' : 'transparent',
                    border: colorBy === 'tokens' ? '1px solid #8A8A8A' : '1px solid #C6C6C6',
                  }}
                />
                tokens
              </button>
              <button
                type="button"
                onClick={() => onColorByChange('type')}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  fontFamily: fontSans,
                  fontSize: 11,
                  lineHeight: '16px',
                  color: colorBy === 'type' ? '#2B2B2B' : '#C6C6C6',
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 3,
                    boxSizing: 'border-box',
                    background: colorBy === 'type' ? '#C6C6C6' : 'transparent',
                    border: colorBy === 'type' ? '1px solid #8A8A8A' : '1px solid #C6C6C6',
                  }}
                />
                type
              </button>
            </div>
          </div>
        </div>

        {activeFilterDomain && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
              gap: '4px 5px',
              minWidth: 0,
              flex: '1 1 220px',
            }}
          >
            <div
              style={{
                width: 1,
                height: 14,
                background: '#DBDBDB',
                flexShrink: 0,
                marginRight: 2,
              }}
            />
            <span
              style={{
                fontSize: 10,
                fontWeight: 400,
                lineHeight: '14px',
                color: '#2B2B2B',
                flexShrink: 0,
              }}
            >
              Filter
            </span>
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                onClick={() => setFilterMode('duration')}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 3,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  fontFamily: fontSans,
                  fontSize: 10,
                  lineHeight: '14px',
                  color: filterMode === 'duration' ? '#2B2B2B' : '#C6C6C6',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    boxSizing: 'border-box',
                    background: filterMode === 'duration' ? '#C6C6C6' : 'transparent',
                    border: filterMode === 'duration' ? '1px solid #8A8A8A' : '1px solid #C6C6C6',
                  }}
                />
                duration
              </button>
              <button
                type="button"
                onClick={() => setFilterMode('tokens')}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 3,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  fontFamily: fontSans,
                  fontSize: 10,
                  lineHeight: '14px',
                  color: filterMode === 'tokens' ? '#2B2B2B' : '#C6C6C6',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    boxSizing: 'border-box',
                    background: filterMode === 'tokens' ? '#C6C6C6' : 'transparent',
                    border: filterMode === 'tokens' ? '1px solid #8A8A8A' : '1px solid #C6C6C6',
                  }}
                />
                tokens
              </button>
            </div>
            <input
              className="subtask-card-duration-filter-range"
              type="range"
              min={activeFilterDomain.min}
              max={activeFilterDomain.max}
              step={activeFilterStep}
              value={activeFilterValue}
              onChange={(e) => {
                setFilterTouched(true)
                if (filterMode === 'duration') {
                  setDurationHighlightMinMs(Number(e.target.value))
                  return
                }
                setTokenHighlightMin(Number(e.target.value))
              }}
              title={
                filterMode === 'duration'
                  ? 'Time filter — minimum duration to highlight'
                  : 'Token filter — minimum tokens to highlight'
              }
              aria-label={
                filterMode === 'duration'
                  ? 'Time filter: minimum duration to highlight'
                  : 'Token filter: minimum tokens to highlight'
              }
              style={{
                minWidth: 56,
                flex: '1 1 96px',
                maxWidth: '100%',
                height: 14,
                verticalAlign: 'middle',
              }}
            />
            <span
              style={{
                fontSize: 10,
                fontWeight: 500,
                lineHeight: '14px',
                color: '#6A6A6A',
                whiteSpace: 'nowrap',
                flexShrink: 1,
                minWidth: 0,
              }}
            >
              {activeFilterMaxLabel}·{matchedActionCount}/{flowActions.length}
            </span>
          </div>
        )}
      </div>

      <div
        style={{
          flex: '0 0 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {(() => {
          /**
           * Fork compare mode feeds ghost rows + forked branch through one ActionFlowVisualization; otherwise render
           * plain `flowActions` for the live session.
           */
          const useForkMerged = forkMergedFlow != null
          const renderActions = useForkMerged ? forkMergedFlow!.merged : flowActions
          const renderTooltips = useForkMerged ? forkMergedFlow!.mergedTooltips : tooltipLookupMessages
          const forkAnchor = useForkMerged ? forkMergedFlow!.anchorActionKey : null
          return (
            <ActionFlowVisualization
              actions={renderActions}
              durationMode={actionsDurationOn}
              colorMode={colorBy}
              actionTypePaletteId={actionTypePaletteId}
              durationHighlightMinMs={durationHighlightForFlow}
              tokenHighlightMin={tokenHighlightForFlow}
              tooltipMessages={renderTooltips}
              highlightedActionType={selectedActionType}
              highlightedActionKey={selectedActionKey}
              dimAll={otherSubtaskHasSelection}
              onSelectAction={onSelectActionFromFlow}
              forkAnchorActionKey={forkAnchor}
              onForkFromAction={handleForkFromActionWrapped}
              onAnalyzeFromAction={onAnalyzeFromAction}
              showFlowEndNode={showFlowEndNode}
              flowEndSummary={flowEndSummary}
              viewportMaxHeight={FLOW_VIEWPORT_MAX_HEIGHT}
            />
          )
        })()}
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'nowrap',
          alignItems: 'stretch',
          gap: 6,
          width: '100%',
          flexShrink: 0,
        }}
      >
        <MetricBox label="LLM calls" value={String(m.llmCallCount)} />
        <MetricBox label="Changes" value={changesLabel} />
        <MetricBox label="Time" value={durationLabel} alert={hasLongRunningAction} />
        <MetricBox label="Total Tokens" value={String(m.tokensSegmentSum)} />
        <MetricBox label="Cost" value={formatSubtaskCostDisplay(m)} />
      </div>
    </>
  )

  const cardInnerStyle: CSSProperties = {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    minHeight: CARD_MIN_HEIGHT,
    height: 'auto',
    flexShrink: 0,
    padding: '12px 14px',
    gap: 4,
    width: '100%',
    minWidth: 0,
    background: isLinked ? '#FFFFFF' : '#FCFCFC',
    borderRadius: 14,
    fontFamily: fontSans,
    overflow: 'visible',
    cursor: onSelectSubtask ? 'pointer' : 'default',
    transition: 'box-shadow 0.15s ease, border-color 0.15s ease, background-color 0.15s ease',
    border: hasLongRunningAction
      ? (isLinked ? '2px solid #FF6B6B' : '1px solid #FF6B6B')
      : (isLinked ? '2px solid #5A8FFF' : '1px solid #DBDBDB'),
    boxShadow: isLinked
      ? `0 0 0 3px rgba(90, 143, 255, 0.22), 0 6px 18px rgba(90, 143, 255, 0.12)`
      : 'none',
  }

  return (
    <div
      ref={cardRef}
      data-subtask-card-index={cardIndex ?? displayIndex}
      onClick={() => onSelectSubtask?.()}
      style={{ ...cardInnerStyle, marginBottom: 8 }}
    >
      {bodyContent}
    </div>
  )
}
