import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type {
  MappedAction,
  OcMessage,
  OcPendingPermissionRequest,
  OcPermissionTraceEvent,
  OcSessionCompactionEvent,
} from '../types/opencode'
import { type AssistantSubtask } from '../utils/subtaskGrouping'
import { isSubtaskPanelSealed } from '../utils/panelSeal'
import {
  buildSubtaskCardMetrics,
  formatDurationMs,
  formatSubtaskCostDisplay,
  mergeSubtaskCardMetrics,
} from '../utils/subtaskMetrics'
import { buildFlowEndSummary } from '../utils/flowEndSummary'
import {
  applyParallelLayoutFromCalls,
  buildChildSessionBandMap,
  buildChildSessionBranchActions,
  buildMappedActionsFromMessages,
  collectTaskChildDescriptors,
  detectParallelCallMapping,
  extractChildSessionIdFromToolPart,
  isSubagentToolName,
  mappedActionFromCompactionEvent,
  mappedActionFromPermissionTrace,
  mergeActions,
} from '../utils/actionMapping'
import {
  buildForkPrefixMetricsFromSnapshot,
  type ForkFromActionContext,
  type ForkPanelSnapshotBundle,
} from '../utils/forkPanelSnapshot'
import { mergeMessagesForActionTooltipLookup } from '../utils/actionTooltipMapping'
import ActionFlowVisualization from './ActionFlowVisualization'
import {
  type ActionTypePaletteId,
} from '../styles/actionTypePalettes'
import { getMessages } from '../services/opencodeApi'
import { experimentTelemetry } from '../experiment/telemetry'
import { actionKey } from '../utils/actionKey'
import type { MemoryWorkerErrorDiagnosis } from '../services/memoryWorkerApi'

const fontSans =
  "'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"

/** Minimum card height; grows with richer content such as fork comparison */
const CARD_MIN_HEIGHT = 220
/** Cap trace viewport at ~two stacked subtask cards — lanes grow until this limit, then scroll */
const FLOW_VIEWPORT_MAX_HEIGHT = CARD_MIN_HEIGHT * 2
const LONG_RUNNING_MS = 60_000

function sanitizeSnapshotFilePart(value: string): string {
  return value
    .trim()
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? '-' : char))
    .join('')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
}

function readSvgSize(svg: SVGSVGElement): { width: number; height: number } {
  const attrWidth = Number(svg.getAttribute('width'))
  const attrHeight = Number(svg.getAttribute('height'))
  if (Number.isFinite(attrWidth) && attrWidth > 0 && Number.isFinite(attrHeight) && attrHeight > 0) {
    return { width: attrWidth, height: attrHeight }
  }
  const box = svg.getBBox()
  return { width: Math.ceil(box.width), height: Math.ceil(box.height) }
}

/**
 * Icons tint via `style="color: …"` + `currentColor`. Standalone SVG viewers often ignore that and
 * fall back to black — bake the computed color into fill/stroke before export.
 */
function bakeCurrentColorForSvgExport(root: SVGSVGElement): void {
  const iconGroups = root.querySelectorAll<SVGGElement>('g.action-flow-action-icon')
  for (const group of iconGroups) {
    const color =
      group.style.color?.trim() ||
      group.getAttribute('style')?.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1]?.trim()
    if (!color || color === 'currentColor') continue

    const painted = group.querySelectorAll<SVGElement>('[fill], [stroke]')
    for (const el of painted) {
      if (el.getAttribute('fill') === 'currentColor') el.setAttribute('fill', color)
      if (el.getAttribute('stroke') === 'currentColor') el.setAttribute('stroke', color)
    }
  }
}

/** Turn `url(http://host/app#id)` / `url("#id")` into a file-local `url(#id)`. */
function toLocalFragmentUrl(value: string): string {
  return value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_full, _q: string, ref: string) => {
    const hashIdx = ref.lastIndexOf('#')
    if (hashIdx < 0) return `url(${ref})`
    const id = ref.slice(hashIdx + 1).replace(/['"]/g, '')
    return id ? `url(#${id})` : _full
  })
}

/**
 * Live DOM often expands `url(#id)` into absolute page URLs (`url(http://host/#id)`).
 * Standalone SVG files then lose arrow markers / masks — rewrite every paint server ref to `#id`.
 */
function rewriteLocalUrlRefsForSvgExport(root: SVGSVGElement): void {
  const attrs = [
    'marker-end',
    'marker-start',
    'marker-mid',
    'fill',
    'stroke',
    'filter',
    'clip-path',
    'mask',
    'href',
    'xlink:href',
  ] as const

  const walk = (el: Element) => {
    for (const attr of attrs) {
      const raw = el.getAttribute(attr)
      if (!raw || !/url\(/i.test(raw)) continue
      el.setAttribute(attr, toLocalFragmentUrl(raw))
    }
    const style = el.getAttribute('style')
    if (style && /url\(/i.test(style)) {
      el.setAttribute('style', toLocalFragmentUrl(style))
    }
    for (const child of Array.from(el.children)) walk(child)
  }
  walk(root)
}

type ExportMarkerDef = {
  d: string
  fill: string
  refX: number
  refY: number
  markerWidth: number
  markerHeight: number
  vbW: number
  vbH: number
}

function readMarkerDefs(root: SVGSVGElement): Map<string, ExportMarkerDef> {
  const out = new Map<string, ExportMarkerDef>()
  for (const marker of root.querySelectorAll('marker')) {
    const id = marker.getAttribute('id')
    if (!id) continue
    const path = marker.querySelector('path')
    const vbParts = (marker.getAttribute('viewBox') || '0 -5 10 10').trim().split(/\s+/).map(Number)
    const vbW = Number.isFinite(vbParts[2]) && vbParts[2]! > 0 ? vbParts[2]! : 10
    const vbH = Number.isFinite(vbParts[3]) && vbParts[3]! > 0 ? vbParts[3]! : 10
    out.set(id, {
      d: path?.getAttribute('d') || 'M0,-5L10,0L0,5',
      fill: path?.getAttribute('fill') || '#9AA0A6',
      refX: Number(marker.getAttribute('refX') || 0),
      refY: Number(marker.getAttribute('refY') || 0),
      markerWidth: Number(marker.getAttribute('markerWidth') || 5),
      markerHeight: Number(marker.getAttribute('markerHeight') || 5),
      vbW,
      vbH,
    })
  }
  return out
}

function markerIdFromRef(raw: string | null | undefined): string | null {
  if (!raw) return null
  const hashIdx = raw.lastIndexOf('#')
  if (hashIdx < 0) return null
  const id = raw.slice(hashIdx + 1).replace(/['"\)]/g, '').trim()
  return id || null
}

/**
 * Many standalone SVG viewers (Preview / some editors) drop `marker-end` arrowheads.
 * Measure tips on the live SVG, then bake real `<path>` geometry into the clone.
 */
function inlineArrowMarkersForSvgExport(liveRoot: SVGSVGElement, cloneRoot: SVGSVGElement): void {
  const markers = readMarkerDefs(cloneRoot)
  if (markers.size === 0) return

  const liveEls = liveRoot.querySelectorAll<SVGGeometryElement>('path, line, polyline')
  const cloneEls = cloneRoot.querySelectorAll<SVGGeometryElement>('path, line, polyline')

  for (let i = 0; i < liveEls.length; i++) {
    const liveEl = liveEls[i]!
    const cloneEl = cloneEls[i]
    if (!cloneEl) continue

    const endId = markerIdFromRef(
      liveEl.getAttribute('marker-end') || cloneEl.getAttribute('marker-end'),
    )
    if (!endId) continue
    const marker = markers.get(endId)
    if (!marker) continue

    let tipX = 0
    let tipY = 0
    let angleDeg = 0
    try {
      if (typeof liveEl.getTotalLength !== 'function' || typeof liveEl.getPointAtLength !== 'function') {
        continue
      }
      const len = liveEl.getTotalLength()
      if (!(len > 0)) continue
      const tip = liveEl.getPointAtLength(len)
      const before = liveEl.getPointAtLength(Math.max(0, len - Math.min(2, len)))
      tipX = tip.x
      tipY = tip.y
      angleDeg = (Math.atan2(tip.y - before.y, tip.x - before.x) * 180) / Math.PI
    } catch {
      continue
    }

    const strokeWidth = Number(
      cloneEl.getAttribute('stroke-width') || liveEl.getAttribute('stroke-width') || 1.5,
    )
    const sx = (marker.markerWidth / marker.vbW) * strokeWidth
    const sy = (marker.markerHeight / marker.vbH) * strokeWidth

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('data-export-arrow', '1')
    g.setAttribute(
      'transform',
      `translate(${tipX}, ${tipY}) rotate(${angleDeg}) scale(${sx}, ${sy}) translate(${-marker.refX}, ${-marker.refY})`,
    )
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    arrow.setAttribute('d', marker.d)
    arrow.setAttribute('fill', marker.fill)
    arrow.setAttribute('stroke', 'none')
    g.appendChild(arrow)
    cloneEl.parentNode?.insertBefore(g, cloneEl.nextSibling)
    cloneEl.removeAttribute('marker-end')
  }
}

function downloadSvg(svg: SVGSVGElement, filename: string): void {
  if (svg.childElementCount === 0) throw new Error('The action flow has not rendered yet.')

  const { width, height } = readSvgSize(svg)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('The action flow has an invalid size.')
  }

  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
  // Pad so arrowheads at path ends are not clipped by the viewBox edge.
  const pad = 8
  clone.setAttribute('width', String(width + pad * 2))
  clone.setAttribute('height', String(height + pad * 2))
  clone.setAttribute('viewBox', `${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}`)
  clone.setAttribute('overflow', 'visible')

  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  background.setAttribute('x', String(-pad))
  background.setAttribute('y', String(-pad))
  background.setAttribute('width', String(width + pad * 2))
  background.setAttribute('height', String(height + pad * 2))
  background.setAttribute('fill', '#FFFFFF')
  const defs = clone.querySelector('defs')
  if (defs?.parentNode === clone) {
    clone.insertBefore(background, defs)
  } else {
    clone.insertBefore(background, clone.firstChild)
  }

  bakeCurrentColorForSvgExport(clone)
  rewriteLocalUrlRefsForSvgExport(clone)
  inlineArrowMarkersForSvgExport(svg, clone)

  const svgText = new XMLSerializer().serializeToString(clone)
  const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
  const svgUrl = URL.createObjectURL(svgBlob)
  try {
    const link = document.createElement('a')
    link.href = svgUrl
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
  } finally {
    URL.revokeObjectURL(svgUrl)
  }
}

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
  /** Fired once when this panel's trajectory becomes sealed (golden end node eligible). */
  onPanelSealed?: (subtaskId: string) => void
  /** Shows the title-row comment affordance while collecting skill feedback. */
  feedbackMode?: boolean
  isFeedbackSelected?: boolean
  hasFeedbackComment?: boolean
  onToggleFeedbackSelection?: () => void
  onOpenFeedbackComment?: () => void
  /** Live permission ask from SSE — dialog is owned by MessagePanel; flow uses `permissionTraces` */
  pendingPermission?: OcPendingPermissionRequest | null
  showPendingPermission?: boolean
  /** Permission asks for this card (pending + answered) — stay on the trajectory */
  permissionTraces?: OcPermissionTraceEvent[]
  /** Live SSE compaction marker — merged when this card should host it and messages lack a compaction part */
  recentCompaction?: OcSessionCompactionEvent | null
  showRecentCompaction?: boolean
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
  onPanelSealed,
  feedbackMode = false,
  isFeedbackSelected = false,
  hasFeedbackComment = false,
  onToggleFeedbackSelection,
  onOpenFeedbackComment,
  pendingPermission = null,
  showPendingPermission = false,
  permissionTraces = [],
  recentCompaction = null,
  showRecentCompaction = false,
}: SubtaskCardProps) {
  const [nowTick, setNowTick] = useState(() => Date.now())
  /** While a flow tip is pinned open, slow live redraw so content is easier to read. */
  const [flowTooltipOpen, setFlowTooltipOpen] = useState(false)
  const [actionsDurationOn, setActionsDurationOn] = useState(false)
  const [filterMode, setFilterMode] = useState<FilterMode>('duration')
  const [snapshotBusy, setSnapshotBusy] = useState(false)
  /** Single-line ellipsis by default; click expands to wrapped full title. */
  const [titleExpanded, setTitleExpanded] = useState(false)
  const [titleOverflows, setTitleOverflows] = useState(false)
  /** DOM anchor only — use outer wrapper for fork/scroll */
  const cardRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLHeadingElement | null>(null)
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

  useEffect(() => {
    setTitleExpanded(false)
  }, [m.title, subtask.subtask_id])

  useEffect(() => {
    const el = titleRef.current
    if (!el) return

    const measure = () => {
      if (titleExpanded) {
        setTitleOverflows(true)
        return
      }
      setTitleOverflows(el.scrollWidth > el.clientWidth + 1)
    }

    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [m.title, titleExpanded])

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
    /** Same cadence as the live duration tick so child rails stay in sync; slow while reading a tooltip. */
    const intervalMs = flowTooltipOpen ? 5000 : 3200
    const id = window.setInterval(() => {
      void loadChildBranches()
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [hasRunningTaskWithChild, loadChildBranches, flowTooltipOpen])

  const flowActions = useMemo(() => {
    const sseExtra: (MappedAction & { row: number })[] = []
    for (const t of permissionTraces) {
      sseExtra.push(mappedActionFromPermissionTrace(t, nowTick))
    }
    // Fallback if traces lag behind a brand-new ask still only in pendingPermission
    if (
      showPendingPermission &&
      pendingPermission &&
      !permissionTraces.some((t) => t.id === pendingPermission.id)
    ) {
      sseExtra.push(
        mappedActionFromPermissionTrace(
          {
            id: pendingPermission.id,
            permission: pendingPermission.permission,
            patterns: pendingPermission.patterns,
            askedAt: pendingPermission.askedAt ?? nowTick,
            status: 'pending',
            tool: pendingPermission.tool,
            sessionID: pendingPermission.sessionID,
          },
          nowTick,
        ),
      )
    }
    const hasCompactionPart = parentFlowActions.some((a) => a.actionType === 'Compaction')
    if (showRecentCompaction && recentCompaction && !hasCompactionPart) {
      sseExtra.push(mappedActionFromCompactionEvent(recentCompaction, nowTick))
    }
    const withSse = mergeActions(parentFlowActions, sseExtra)
    const merged = [...withSse, ...childBranchActions].sort((a, b) => a.sortTime - b.sortTime)
    return applyParallelLayoutFromCalls(merged, parallelByCallId)
  }, [
    parentFlowActions,
    childBranchActions,
    parallelByCallId,
    permissionTraces,
    showPendingPermission,
    pendingPermission,
    showRecentCompaction,
    recentCompaction,
    nowTick,
  ])

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

  /** Matches `mergeMessagesForActionTooltipLookup`: parent segment + fetched child rows */
  const tooltipLookupMessages = useMemo(
    () => mergeMessagesForActionTooltipLookup(segmentMessages, childBranchMessages),
    [segmentMessages, childBranchMessages],
  )

  const handleDownloadSnapshot = useCallback(() => {
    const svg = cardRef.current?.querySelector<SVGSVGElement>('svg[data-action-flow-root="1"]')
    if (!svg) {
      window.alert('Snapshot failed: action flow SVG is not ready yet.')
      return
    }

    const safeTitle = sanitizeSnapshotFilePart(m.title) || `panel-${displayIndex + 1}`
    setSnapshotBusy(true)
    try {
      downloadSvg(svg, `vibetrace-${displayIndex + 1}-${safeTitle}.svg`)
    } catch (err) {
      window.alert(`Snapshot failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSnapshotBusy(false)
    }
  }, [displayIndex, m.title])

  /**
   * Absolute subtask index in `assistantSubtasks` (not the filtered visible-row `displayIndex` / `si`).
   * Fork snapshots store `forkOriginDisplayIndex` as this source index; Rule C must compare against it.
   */
  const forkSourceIndex = cardIndex ?? displayIndex

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
   *    → New branch is in the NEXT subtask (forkSourceIndex + 1). Render this card normally so the
   *      origin copy is not shown twice; the full comparison appears in the next card via Rule C.
   *
   * C) Anchor NOT found AND forkSourceIndex === forkOriginDisplayIndex + 1:
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
       * Compare absolute source indices (cardIndex), not filtered visible-row indices (displayIndex/si).
       */
      if (forkSourceIndex !== b.forkOriginDisplayIndex + 1) return null
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
  }, [forkPanelSnapshotBundle, forkSourceIndex, flowActions, tooltipLookupMessages])

  /**
   * Filter domains cover everything drawn in the SVG (shared prefix + ghosts + new branch).
   * Bottom strip metrics use the live session path (prefix + new branch), not abandoned ghosts.
   */
  const filterBasisActions = forkMergedFlow?.merged ?? flowActions

  const durationDomain = useMemo(() => {
    const vals = filterBasisActions
      .map((a) => a.durationMs)
      .filter((v): v is number => Number.isFinite(v) && v >= 0)
    if (!vals.length) return null
    return { min: Math.min(...vals), max: Math.max(...vals) }
  }, [filterBasisActions])
  const tokenDomain = useMemo(() => {
    const vals = filterBasisActions
      .map((a) => a.tokenEstimate)
      .filter((v): v is number => Number.isFinite(v) && v >= 0)
    if (!vals.length) return null
    return { min: Math.min(...vals), max: Math.max(...vals) }
  }, [filterBasisActions])
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
      if (!durationDomain) return filterBasisActions.length
      return filterBasisActions.filter(
        (a) => Number.isFinite(a.durationMs) && a.durationMs >= effectiveFilterMin
      ).length
    }
    if (!tokenDomain) return filterBasisActions.length
    return filterBasisActions.filter(
      (a) => Number.isFinite(a.tokenEstimate) && a.tokenEstimate >= effectiveFilterMin
    ).length
  }, [filterMode, filterBasisActions, durationDomain, tokenDomain, effectiveFilterMin])
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

  /**
   * Rule C cards only contain the post-fork turn; top up strip stats with the snapshot prefix
   * (shared history before the anchor). Rule A already has the prefix in live `m`.
   */
  const displayMetrics = useMemo(() => {
    if (!forkMergedFlow || !forkPanelSnapshotBundle) return m
    const anchorMessageId = forkPanelSnapshotBundle.forkAnchorMessageId
    const anchorPartId = forkPanelSnapshotBundle.forkAnchorPartId
    const anchorInCurrent = flowActions.some(
      (a) =>
        a.messageID === anchorMessageId && (anchorPartId ? a.partId === anchorPartId : true),
    )
    if (anchorInCurrent) return m
    const prefix = buildForkPrefixMetricsFromSnapshot(forkPanelSnapshotBundle, nowTick)
    if (!prefix) return m
    return mergeSubtaskCardMetrics(prefix, m)
  }, [forkMergedFlow, forkPanelSnapshotBundle, flowActions, m, nowTick])

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

  const FLOW_TICK_MS = 2000
  const FLOW_TICK_WHILE_TOOLTIP_MS = 5000

  useEffect(() => {
    if (!hasActiveRunningAction) return
    /**
     * Heartbeat bumps `parentFlowActions`/`flowActions` so ActionFlowVisualization’s D3 effect rebuilds.
     * Default 2s; while a tooltip is open, 5s so the user can finish reading before the next wipe.
     */
    const intervalMs = flowTooltipOpen ? FLOW_TICK_WHILE_TOOLTIP_MS : FLOW_TICK_MS
    const id = window.setInterval(() => setNowTick(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [hasActiveRunningAction, flowTooltipOpen])

  const handleFlowTooltipOpenChange = useCallback((open: boolean) => {
    setFlowTooltipOpen((prev) => {
      if (prev === open) return prev
      return open
    })
    if (open) experimentTelemetry.enterPanelFocus('tooltip')
    else experimentTelemetry.leavePanelFocus('tooltip', 'trajectory')
  }, [])

  const wasFlowTooltipOpenRef = useRef(false)
  useEffect(() => {
    const wasOpen = wasFlowTooltipOpenRef.current
    wasFlowTooltipOpenRef.current = flowTooltipOpen
    if (wasOpen && !flowTooltipOpen && hasActiveRunningAction) {
      // Tooltip / hover ended: catch up once, then the 2s interval resumes.
      setNowTick(Date.now())
    }
  }, [flowTooltipOpen, hasActiveRunningAction])

  const durationLabel = formatDurationMs(displayMetrics.durationMs)
  const changesLabel = String(displayMetrics.mutatedFileCount)
  /**
   * Golden end circle only after this panel’s trace is confirmed finished — not as soon as the first
   * Think/Response appears (those parts are always mapped as `completed` while the turn may still be live).
   * Finished when: no running/pending tools, and either the last assistant turn stopped (`finish: stop` /
   * step-finish stop) or a later message has already sealed this panel.
   */
  const showFlowEndNode = useMemo(() => {
    if (flowActions.length === 0 || hasActiveRunningAction) return false
    return isSubtaskPanelSealed(subtask, messages)
  }, [flowActions.length, hasActiveRunningAction, messages, subtask])

  /** Once notified for this subtaskId, never re-fire — even if the end node flickers. */
  const panelSealedNotifiedForIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!showFlowEndNode) return
    if (panelSealedNotifiedForIdRef.current === subtask.subtask_id) return
    panelSealedNotifiedForIdRef.current = subtask.subtask_id
    onPanelSealed?.(subtask.subtask_id)
  }, [showFlowEndNode, onPanelSealed, subtask.subtask_id])

  /**
   * Stabilize `flowEndSummary` identity — inline object literals each render fooled ActionFlowVisualization’s first
   * `useLayoutEffect` into `selectAll('*').remove()`, wiping the SVG whenever clicks/`nowTick` fired.
   */
  const flowEndSummary = useMemo(
    () => buildFlowEndSummary(displayMetrics, errorDiagnosis),
    [
      displayMetrics.readFilesCount,
      displayMetrics.readFilePaths,
      displayMetrics.globMatchFileCount,
      displayMetrics.webSearchCallCount,
      displayMetrics.webSearchQueries,
      displayMetrics.mutatedFileCount,
      displayMetrics.mutatedFilePaths,
      errorDiagnosis,
      displayMetrics,
    ],
  )

  /** Ghost rail terminator reuses the source-session summary captured at fork time. */
  const ghostFlowEndSummary = forkPanelSnapshotBundle?.originFlowEndSummary ?? null

  /** Same memo trick for fork handler identity */
  const handleForkFromActionWrapped = useMemo(() => {
    if (!onForkFromAction) return undefined
    return (act: MappedAction & { row: number }) =>
      onForkFromAction(act, {
        subtaskId: subtask.subtask_id,
        /** Must be absolute sourceIndex — snapshot + App resolve tabs by this, not filtered `si`. */
        subtaskDisplayIndex: forkSourceIndex,
        assistantMessageIndices: subtask.assistantMessageIndices,
      })
  }, [onForkFromAction, subtask.subtask_id, subtask.assistantMessageIndices, forkSourceIndex])

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
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            flex: 1,
          }}
        >
          {feedbackMode ? (
            <label
              onClick={(e) => e.stopPropagation()}
              title={isFeedbackSelected ? 'Deselect panel' : 'Select panel for feedback trace'}
              style={{
                flex: '0 0 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={isFeedbackSelected}
                onChange={() => onToggleFeedbackSelection?.()}
                aria-label={`Select panel for feedback trace`}
                style={{
                  width: 14,
                  height: 14,
                  margin: 0,
                  accentColor: '#2F7DD1',
                  cursor: 'pointer',
                }}
              />
            </label>
          ) : null}
          <h3
            ref={titleRef}
            title={titleOverflows && !titleExpanded ? 'Click to show full title' : undefined}
            onClick={(e) => {
              if (!titleOverflows && !titleExpanded) return
              e.stopPropagation()
              setTitleExpanded((v) => !v)
            }}
            onKeyDown={(e) => {
              if (!titleOverflows && !titleExpanded) return
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              e.stopPropagation()
              setTitleExpanded((v) => !v)
            }}
            role={titleOverflows || titleExpanded ? 'button' : undefined}
            tabIndex={titleOverflows || titleExpanded ? 0 : undefined}
            aria-expanded={titleOverflows || titleExpanded ? titleExpanded : undefined}
            style={{
              margin: 0,
              fontWeight: 600,
              fontSize: 13,
              lineHeight: '18px',
              color: '#2B2B2B',
              minWidth: 0,
              overflow: titleExpanded ? 'visible' : 'hidden',
              textOverflow: titleExpanded ? 'clip' : 'ellipsis',
              whiteSpace: titleExpanded ? 'normal' : 'nowrap',
              wordBreak: titleExpanded ? 'break-word' : undefined,
              flex: 1,
              cursor: titleOverflows || titleExpanded ? 'pointer' : 'default',
            }}
          >
            {m.title}
          </h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
          <button
            type="button"
            disabled={snapshotBusy}
            onClick={(e) => {
              e.stopPropagation()
              void handleDownloadSnapshot()
            }}
            title="Download this panel action flow as a PNG"
            style={{
              flex: '0 0 auto',
              border: '1px solid #DADADA',
              borderRadius: 999,
              background: snapshotBusy ? '#F3F4F6' : '#FFFFFF',
              color: snapshotBusy ? '#9A9A9A' : '#444',
              padding: '3px 8px',
              fontSize: 10,
              lineHeight: '14px',
              fontWeight: 650,
              cursor: snapshotBusy ? 'wait' : 'pointer',
            }}
          >
            {snapshotBusy ? 'Saving' : 'Snapshot'}
          </button>
          {feedbackMode ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onOpenFeedbackComment?.()
              }}
              title={hasFeedbackComment ? 'View or edit feedback for this panel' : 'Write feedback for this panel'}
              style={{
                flex: '0 0 auto',
                border: hasFeedbackComment ? '1px solid #86B6FF' : '1px solid #D7E3F8',
                borderRadius: 999,
                background: isFeedbackSelected ? '#EDF5FF' : '#FFFFFF',
                color: hasFeedbackComment ? '#185EA8' : '#44607C',
                padding: '3px 8px',
                fontSize: 10,
                lineHeight: '14px',
                fontWeight: 650,
                cursor: 'pointer',
                boxShadow: hasFeedbackComment ? '0 1px 6px rgba(24, 94, 168, 0.12)' : 'none',
              }}
            >
              {hasFeedbackComment ? 'Commented' : 'Comment'}
            </button>
          ) : null}
        </div>
      </div>

      <div
        onClick={e => e.stopPropagation()}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: 'nowrap',
          gap: 10,
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
            flexWrap: 'nowrap',
            gap: 8,
            flexShrink: 0,
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
              gap: 5,
              minWidth: 0,
              flexWrap: 'nowrap',
              flex: '1 1 auto',
              marginLeft: 'auto',
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
                maxWidth: 140,
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
          const hasGhostSuffix =
            useForkMerged && renderActions.some((a) => a.forkGhost === true)
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
              showGhostEndNode={hasGhostSuffix ? true : undefined}
              showForkBranchEndNode={useForkMerged ? showFlowEndNode : undefined}
              flowEndSummary={flowEndSummary}
              ghostFlowEndSummary={ghostFlowEndSummary}
              viewportMaxHeight={FLOW_VIEWPORT_MAX_HEIGHT}
              telemetrySubtaskId={subtask.subtask_id}
              onTooltipOpenChange={handleFlowTooltipOpenChange}
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
        <MetricBox label="LLM calls" value={String(displayMetrics.llmCallCount)} />
        <MetricBox label="Changes" value={changesLabel} />
        <MetricBox label="Time" value={durationLabel} alert={hasLongRunningAction} />
        <MetricBox label="Total Tokens" value={String(displayMetrics.tokensSegmentSum)} />
        <MetricBox label="Cost" value={formatSubtaskCostDisplay(displayMetrics)} />
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
