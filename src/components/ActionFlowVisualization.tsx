import { useEffect, useLayoutEffect, useRef, useId, useMemo, useState } from 'react'
import * as d3 from 'd3'
import { Tooltip } from 'react-tooltip'
import type { MappedAction, OcMessage } from '../types/opencode'
import { buildCompactMappedActionTooltipHtml } from '../utils/actionTooltipMapping'
import { actionFlowPalette } from '../styles/actionFlowPalette'
import {
  type ActionTypePaletteId,
  DEFAULT_ACTION_TYPE_PALETTE_ID,
} from '../styles/actionTypePalettes'
import { effectiveStatusColors, resolveActionBlockColors, statusColors } from '../utils/actionFlowColors'
import { appendActionFlowIcon, getActionFlowIconSvg } from './actionFlowIcons'
import ActionFlowContextMenu, { type ActionFlowContextMenuState } from './ActionFlowContextMenu'
import { actionKey } from '../utils/actionKey'

type FlowNode =
  | { kind: 'end'; row: number; sessionRegion: 'main' | 'fork-new-branch' }
  | (MappedAction & { row: number; kind: 'action' })

/** Single item from `computeLayout`, used when bundling connector edges */
type FlowLayoutItem = {
  node: FlowNode
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
}

const MARGIN_LEFT = 24
const GAP = 12
/**
 * Vertical layout (consistent with `actionMapping`):
 * - Each session uses two baseline layers: layer0 = kernel (Think / Response / Plan…), layer1 = tools, etc.;
 * - Parent-side task (Subagent): once `childSessionID` is known, its rect moves into **`session:task:`** child-session lanes (no longer drawn in the main session band);
 * - Each sub-agent is a stacked swimlane (`session:task:<callID>`); parallel siblings share x, merge edges only at group end;
 * - `parallelLaneIndex` only offsets actions still on `session:main` (parallel tools without a dedicated task band);
 * - Child-session bands sit below `main`, with their own layers and lanes — height is not fixed.
 */
const BLOCK_H = 28
const ROW_H = 32
/** Vertical stagger for parallel lanes on the same logical row (same step as primary row spacing) */
const PARALLEL_LANE_DY = ROW_H
const SESSION_REGION_GAP = 10
const TOP_PAD = 4
const MIN_W = 28
/** Duration mode: durations ≤ this use the minimum block width (ms) */
const DUR_WIDTH_BASE_MS = 10
/** Duration mode: reference wall-clock duration paired with `DUR_BLOCK_AT_REF_PX` */
const DUR_REF_MS = 120_000
/** Duration mode: block outer edge at `DUR_REF_MS` (still `MIN_W` when `<= DUR_WIDTH_BASE_MS`) */
const DUR_BLOCK_AT_REF_PX = 200
const DUR_BETA_MS = Math.max(1, DUR_REF_MS - DUR_WIDTH_BASE_MS)
/**
 * Action block width: `w = MIN_W + DUR_PX_PER_MS * (durationMs - 10)` — below ~10 ms stays 28px, at 120s reaches 200px, then scales linearly.
 * Independent tuning from inter-slot gaps; see `DUR_GAP_MIN_PX` / `DUR_GAP_REF_PX`.
 */
const DUR_PX_PER_MS = (DUR_BLOCK_AT_REF_PX - MIN_W) / DUR_BETA_MS
/**
 * Idle gap width between slots (px): floors at `DUR_GAP_MIN_PX`, reaches `DUR_GAP_REF_PX` at `DUR_GAP_REF_MS`
 * (“gap analogue” of the block width slope from the ~10 ms baseline):
 * `gapPx = DUR_GAP_MIN_PX + DUR_GAP_PX_PER_MS * max(0, gapMs - 10)`.
 * Tweak proportions via `DUR_GAP_*`; optionally align `DUR_WIDTH_BASE_MS` with combined block + gap timelines.
 */
const DUR_GAP_MIN_PX = 10
const DUR_GAP_REF_PX = 200
/** Paired with `DUR_GAP_*`; may differ from `DUR_REF_MS` (blocks) when you tune gap reference duration separately */
const DUR_GAP_REF_MS = DUR_REF_MS
const DUR_GAP_BETA_MS = Math.max(1, DUR_GAP_REF_MS - DUR_WIDTH_BASE_MS)
const DUR_GAP_PX_PER_MS = (DUR_GAP_REF_PX - DUR_GAP_MIN_PX) / DUR_GAP_BETA_MS
const DUR_TAIL_PAD_PX = 2
const BOTTOM_PAD = 6
/** Minimum canvas height when at least two swimlanes and two blocks exist — avoids collapsing the SVG when data is sparse */
const MIN_SVG_CONTENT_HEIGHT = TOP_PAD + 2 * ROW_H + 2 * BLOCK_H + BOTTOM_PAD
/** Clamp visible viewport to ~4 lanes including vertical padding */
/** Matches context-menu typography for ellipsis / SVG text labels */
const SVG_FONT_SANS =
  "'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"
/** Fork snapshots: ghost segments no longer on the branch — rects + connectors */
const FORK_GHOST_STROKE = '#B8B8B8'
const FORK_GHOST_MARKER_FILL = '#B8B8B8'

/**
 * Same slope as blocks past `[10ms,120s] → [28px,200px]`, extrapolating linearly without caps.
 * `w = 28 + DUR_PX_PER_MS * (duration - 10)` whenever duration > 10.
 */
function durationBlockExtraPx(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= DUR_WIDTH_BASE_MS) return 0
  return DUR_PX_PER_MS * (durationMs - DUR_WIDTH_BASE_MS)
}

/**
 * Inter-slot idle `gapMs = next.minStart - prev.maxEnd` (clamped ≥0) maps to layout `interSlotGap` px,
 * roughly matching the horizontal span of orthogonal edge segments.
 * Unlike blocks (`MIN_W = 28`), gaps start from `DUR_GAP_MIN_PX = 10` and hit 200px wide at ~2 min.
 */
function durationGapWidthPx(gapMs: number): number {
  if (!Number.isFinite(gapMs) || gapMs <= 0) return DUR_GAP_MIN_PX
  if (gapMs <= DUR_WIDTH_BASE_MS) return DUR_GAP_MIN_PX
  return DUR_GAP_MIN_PX + DUR_GAP_PX_PER_MS * (gapMs - DUR_WIDTH_BASE_MS)
}

function durationStartOffsetPx(slotStart: number, actionStart: number): number {
  if (!Number.isFinite(slotStart) || !Number.isFinite(actionStart)) return 0
  const deltaMs = Math.max(0, actionStart - slotStart)
  return durationBlockExtraPx(deltaMs)
}

function edgeStrokeAndMarker(
  a: MappedAction & { row: number },
  b: MappedAction & { row: number },
  normalMarkerUrl: string,
  ghostMarkerUrl: string
): { stroke: string; markerUrl: string } {
  if (a.forkGhost || b.forkGhost) {
    return { stroke: FORK_GHOST_STROKE, markerUrl: ghostMarkerUrl }
  }
  return { stroke: actionFlowPalette.arrow, markerUrl: normalMarkerUrl }
}

function blockWidth(durationMode: boolean, durationMs: number): number {
  return durationWidthMeta(durationMode, durationMs).w
}

function durationWidthMeta(
  durationMode: boolean,
  durationMs: number
): { w: number; overThreshold: boolean } {
  if (!durationMode) return { w: MIN_W, overThreshold: false }
  if (!Number.isFinite(durationMs) || durationMs <= 0) return { w: MIN_W, overThreshold: false }
  if (durationMs <= DUR_WIDTH_BASE_MS) return { w: MIN_W, overThreshold: false }
  const w = MIN_W + durationBlockExtraPx(durationMs)
  return { w, overThreshold: false }
}

function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '—'
  const sec = durationMs / 1000
  if (sec < 0.01) return '<0.01s'
  return `${sec.toFixed(2)}s`
}

function rowTopY(row: number): number {
  return TOP_PAD + row * ROW_H
}

function laneOffsetY(parallelLaneIndex?: number): number {
  return (parallelLaneIndex ?? 0) * PARALLEL_LANE_DY
}

/**
 * Vertical stacking of logical sessions / lanes (evaluation order matters):
 * 1. `session:task:<parentTaskCallID>` — child-session actions or parent-side Subagents with `childSessionID`
 *    collapse into matching child-session bands. Fork rules mirror before/after branching.
 * 2. `session:fork-new-branch` — non-task actions on the new branch lane after a fork (`forkCompareRow === 2`),
 *    laid out west-to-east starting at the fork anchor and drawn below legacy regions.
 * 3. `session:main` — everything else belonging to the main process before/for non-fork views.
 *
 * Always classify child-session / Subagent routing before evaluating `forkCompareRow`, otherwise
 * new-branch task nodes may be mis-labeled into `fork-new-branch` bands and visually detach from children.
 */
function actionSessionKey(a: MappedAction & { row: number }): string {
  if (a.source === 'child-session' && a.parentTaskCallID) {
    return `session:task:${a.parentTaskCallID}`
  }
  if (
    a.actionType === 'Subagent' &&
    a.source !== 'child-session' &&
    a.callID &&
    a.childSessionID
  ) {
    return `session:task:${a.callID}`
  }
  if (a.forkCompareRow === 2) {
    return 'session:fork-new-branch'
  }
  return 'session:main'
}

/**
 * Y offset inside a session band. Each sub-agent owns `session:task:<callID>` (full swimlane, stacked below siblings).
 * `parallelLaneIndex` only staggers actions that still share `session:main` (e.g. parallel tools without a task band).
 */
function verticalOffsetInSession(a: MappedAction & { row: number }): number {
  const yRow = actionLocalRowForLayout(a) * ROW_H
  const session = actionSessionKey(a)
  if (session.startsWith('session:task:') || session === 'session:fork-new-branch') {
    return yRow
  }
  return yRow + laneOffsetY(a.parallelLaneIndex)
}

/** Task child-session region → new-branch when parent Subagent has `forkCompareRow === 2` */
function isNewBranchTaskKey(k: string, sorted: (MappedAction & { row: number })[]): boolean {
  if (!k.startsWith('session:task:')) return false
  const callID = k.slice('session:task:'.length)
  const parent = sorted.find(
    (a) => a.actionType === 'Subagent' && a.source !== 'child-session' && a.callID === callID,
  )
  if (parent) return parent.forkCompareRow === 2
  const anyAction = sorted.find((a) => actionSessionKey(a) === k)
  return anyAction?.forkCompareRow === 2
}

/** Sync x within a parallel group: shared left edge per step (non-duration) or per start time (duration). */
function syncParallelGroupHorizontalPositions(
  sorted: (MappedAction & { row: number })[],
  actionXBySortedIndex: Map<number, number>,
  childLocalXByIndex: Map<number, number>,
  durationMode: boolean,
): void {
  const indicesByGroup = new Map<string, number[]>()
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!
    if (!a.parallelGroupId) continue
    let list = indicesByGroup.get(a.parallelGroupId)
    if (!list) {
      list = []
      indicesByGroup.set(a.parallelGroupId, list)
    }
    list.push(i)
  }

  for (const indices of indicesByGroup.values()) {
    const laneSet = new Set(indices.map((i) => sorted[i]!.parallelLaneIndex ?? 0))
    if (laneSet.size < 2) continue

    const parentIdxs = indices.filter((i) => {
      const a = sorted[i]!
      return a.actionType === 'Subagent' && a.source !== 'child-session' && Boolean(a.callID)
    })
    if (parentIdxs.length === 0) continue

    const groupMinSortTime = Math.min(...indices.map((i) => sorted[i]!.sortTime))

    if (!durationMode) {
      const anchorX = Math.min(
        ...parentIdxs.map((i) => actionXBySortedIndex.get(i) ?? MARGIN_LEFT),
      )
      for (const i of parentIdxs) actionXBySortedIndex.set(i, anchorX)
    } else {
      const slotLeft = Math.min(
        ...parentIdxs.map((i) => {
          const a = sorted[i]!
          const x = actionXBySortedIndex.get(i) ?? MARGIN_LEFT
          return x - durationStartOffsetPx(groupMinSortTime, a.sortTime)
        }),
      )
      for (const i of parentIdxs) {
        const a = sorted[i]!
        actionXBySortedIndex.set(
          i,
          slotLeft + durationStartOffsetPx(groupMinSortTime, a.sortTime),
        )
      }
    }

    const childBaseX = Math.min(
      ...parentIdxs.map((i) => {
        const a = sorted[i]!
        const px = actionXBySortedIndex.get(i) ?? MARGIN_LEFT
        return px + blockWidth(durationMode, a.durationMs) + 10
      }),
    )

    for (const i of indices) {
      const a = sorted[i]!
      if (a.source !== 'child-session') continue
      const local = childLocalXByIndex.get(i) ?? 0
      actionXBySortedIndex.set(i, childBaseX + local)
    }
  }
}

/** Whether this action sits on the post-fork “new branch” track (still includes nested tasks/sub-sessions); marked via `forkCompareRow === 2`. */
function isNewBranchAction(a: MappedAction & { row: number }): boolean {
  return a.forkCompareRow === 2
}

/** Parent tasks remain layer1 in payloads; inside child-session **bands** force first row rendering (fresh session headline). */
function actionLocalRowForLayout(a: MappedAction & { row: number }): number {
  if (
    a.actionType === 'Subagent' &&
    a.source !== 'child-session' &&
    a.callID &&
    a.childSessionID
  ) {
    return 0
  }
  return Math.max(0, a.row % 2)
}

/** Vertical center the active rows inside `totalH` by translating the content `<g>`. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function verticalCenterOffsetY(
  layout: { node: FlowNode; y: number; h: number }[],
  totalH: number
): number {
  if (layout.length === 0) return 0
  let minY = Infinity
  let maxY = -Infinity
  for (const item of layout) {
    if (item.y < minY) minY = item.y
    if (item.y + item.h > maxY) maxY = item.y + item.h
  }
  const centerY = (minY + maxY) / 2
  return totalH / 2 - centerY
}

export type FlowEndSummary = {
  /** read path list count + glob match count */
  readFileTotalCount: number
  readFilePaths: string[]
  globMatchFileCount: number
  webSearchCount: number
  webSearchQueries: string[]
  writeFileCount: number
  changedFilePaths: string[]
}

const FLOW_END_MAX_LINES = 12
const FLOW_END_PATH_MAX_CHARS = 72

function truncatePathForFlowEnd(p: string): string {
  const t = p.trim()
  if (t.length <= FLOW_END_PATH_MAX_CHARS) return t
  return `${t.slice(0, FLOW_END_PATH_MAX_CHARS - 1)}…`
}

function flowEndListRows(items: string[], esc: (s: string) => string): { html: string; more: number } {
  const shown = items.slice(0, FLOW_END_MAX_LINES)
  const more = items.length > shown.length ? items.length - shown.length : 0
  const html = shown
    .map(
      (p) =>
        `<div style="font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.4;color:#24292f;">${esc(truncatePathForFlowEnd(p))}</div>`,
    )
    .join('')
  return { html, more }
}

function buildFlowEndTooltipHtml(s: FlowEndSummary): string {
  const esc = escapeHtml
  const readPaths = s.readFilePaths ?? []
  const writePaths = s.changedFilePaths ?? []
  const queries = s.webSearchQueries ?? []

  const readList = flowEndListRows(readPaths, esc)
  const readMore =
    readList.more > 0
      ? `<div style="font-size:11px;color:#57606a;margin-top:4px;">+ ${readList.more} more</div>`
      : ''
  const globLine =
    s.globMatchFileCount > 0
      ? `<div style="font-size:11px;color:#57606a;margin-top:6px;">Glob · ~${esc(String(s.globMatchFileCount))} file(s) matched</div>`
      : ''

  const qList = flowEndListRows(queries, esc)
  const qMore =
    qList.more > 0
      ? `<div style="font-size:11px;color:#57606a;margin-top:4px;">+ ${qList.more} more</div>`
      : ''

  const writeList = flowEndListRows(writePaths, esc)
  const writeMore =
    writeList.more > 0
      ? `<div style="font-size:11px;color:#57606a;margin-top:4px;">+ ${writeList.more} more</div>`
      : ''

  return `<div class="action-tip-root action-tip-root--compact" style="text-align:left;max-width:min(440px,92vw);">
<div style="font-size:12px;font-weight:600;color:#24292f;margin-bottom:4px;">Read</div>
<div style="font-size:11px;color:#57606a;margin-bottom:6px;">${esc(String(s.readFileTotalCount))} file(s) (paths + glob)</div>
${readList.html}${readMore}${globLine}
<div style="font-size:12px;font-weight:600;color:#24292f;margin-top:10px;margin-bottom:4px;">Web search</div>
<div style="font-size:11px;color:#57606a;margin-bottom:6px;">${esc(String(s.webSearchCount))} call(s) · keywords / URLs</div>
${qList.html}${qMore}
<div style="font-size:12px;font-weight:600;color:#24292f;margin-top:10px;margin-bottom:4px;">Write / edit</div>
<div style="font-size:11px;color:#57606a;margin-bottom:6px;">${esc(String(s.writeFileCount))} file(s)</div>
${writeList.html}${writeMore}
</div>`
}

function computeLayout(
  actions: (MappedAction & { row: number })[],
  durationMode: boolean,
  layoutOpts?: {
    includeEndNode?: boolean
    forkAnchorActionKey?: string | null
  }
) {
  const includeEndNode = layoutOpts?.includeEndNode !== false
  const forkAnchorActionKey = layoutOpts?.forkAnchorActionKey ?? null
  const sorted = [...actions].sort((a, b) => a.sortTime - b.sortTime)

  /** Tighter step gap so sequential actions do not drift too far horizontally */
  const TIMELINE_STEP_GAP = 10

  const sessionKeySet = new Set<string>()
  sorted.forEach((a) => sessionKeySet.add(actionSessionKey(a)))

  /**
   * Fork-compare mode activates when any `forkCompareRow === 2` action exists — including the edge case
   * where the new branch only contains task / child-session work with no “primary lane” tooling.
   * `hasForkNewBranchSession` only checks whether `session:fork-new-branch` rows exist (whether to reserve a lane).
   */
  const hasNewBranchAction = sorted.some(isNewBranchAction)
  const hasForkNewBranchSession = sessionKeySet.has('session:fork-new-branch')

  const sessionOrder: string[] = []
  if (sessionKeySet.has('session:main')) sessionOrder.push('session:main')

  /**
   * Fork-compare mode renders two parallel rails, each with its own terminator:
   *  - Legacy timeline (anchor + grey ghosts) → muted end node anchored to the main lane
   *  - New branch actions → standard end node anchored to the fork lane
   * Vanilla sessions still emit a single main end.
   * End nodes carry `sessionRegion` so layout can place x/y deterministically.
   */
  const seq: FlowNode[] = sorted.map(a => ({ ...a, kind: 'action' as const }))
  if (includeEndNode) {
    seq.push({ kind: 'end', row: 1, sessionRegion: 'main' })
    if (hasNewBranchAction) {
      seq.push({ kind: 'end', row: 1, sessionRegion: 'fork-new-branch' })
    }
  }
  const childKeys = [...sessionKeySet].filter(
    (k) => k !== 'session:main' && k !== 'session:fork-new-branch',
  )
  const sortChildKeys = (keys: string[]) => {
    keys.sort((ka, kb) => {
      const actionsA = sorted.filter((a) => actionSessionKey(a) === ka)
      const actionsB = sorted.filter((a) => actionSessionKey(a) === kb)
      const ga = actionsA[0]?.parallelGroupId ?? ''
      const gb = actionsB[0]?.parallelGroupId ?? ''
      if (ga !== gb) return ga.localeCompare(gb)
      const la = actionsA[0]?.parallelLaneIndex ?? 0
      const lb = actionsB[0]?.parallelLaneIndex ?? 0
      if (la !== lb) return la - lb
      const minA = Math.min(...actionsA.map((x) => x.sortTime))
      const minB = Math.min(...actionsB.map((x) => x.sortTime))
      return minA - minB
    })
    return keys
  }
  /**
   * Lane order after fork:
   *   main (legacy anchor + ghosts)
   *   → historical task child regions (parents are legacy Subagents)
   *   → `session:fork-new-branch` (new-track non-task tooling)
   *   → new-branch task regions (parents live on the forked Subagent rail)
   * This keeps nested child sessions from interleaving legacy vs fork content; the fork stack reads as one block.
   */
  const historicalChildKeys = sortChildKeys(childKeys.filter((k) => !isNewBranchTaskKey(k, sorted)))
  const newBranchChildKeys = sortChildKeys(childKeys.filter((k) => isNewBranchTaskKey(k, sorted)))
  sessionOrder.push(...historicalChildKeys)
  if (hasForkNewBranchSession) sessionOrder.push('session:fork-new-branch')
  sessionOrder.push(...newBranchChildKeys)
  if (sessionOrder.length === 0) sessionOrder.push('session:main')

  /** Global canvas x positions (sorted index → x) */
  const actionXBySortedIndex = new Map<number, number>()

  /**
   * Root rail: every action that is neither `child-session` nor on the forked branch (legacy parent timeline).
   * Fork parents (`forkCompareRow === 2`, including forked Subagents) advance on a dedicated branch rail so they
   * never steal horizontal space from the historical spine.
   */
  const rootIndices = sorted
    .map((a, idx) => ({ a, idx }))
    .filter((x) => x.a.source !== 'child-session' && !isNewBranchAction(x.a))
    .map((x) => x.idx)

  /** Root rail slot ids (shared chronological axis) */
  const rootSlotByIndex = new Map<number, string>()
  const rootGroupStepToSlot = new Map<string, Map<number, string>>()
  const rootGroupLaneStepCounter = new Map<string, Map<number, number>>()
  const rootSlotIndices = new Map<string, number[]>()
  let nextRootSlot = 0
  for (const idx of rootIndices) {
    const a = sorted[idx]!
    let slotKey: string
    if (!a.parallelGroupId) {
      slotKey = `root:${nextRootSlot++}`
    } else {
      const groupKey = a.parallelGroupId
      const lane = a.parallelLaneIndex ?? 0
      let laneCounter = rootGroupLaneStepCounter.get(groupKey)
      if (!laneCounter) {
        laneCounter = new Map<number, number>()
        rootGroupLaneStepCounter.set(groupKey, laneCounter)
      }
      const step = laneCounter.get(lane) ?? 0
      laneCounter.set(lane, step + 1)

      let stepSlots = rootGroupStepToSlot.get(groupKey)
      if (!stepSlots) {
        stepSlots = new Map<number, string>()
        rootGroupStepToSlot.set(groupKey, stepSlots)
      }
      if (!stepSlots.has(step)) stepSlots.set(step, `root:${nextRootSlot++}`)
      slotKey = stepSlots.get(step)!
    }
    rootSlotByIndex.set(idx, slotKey)
    let list = rootSlotIndices.get(slotKey)
    if (!list) {
      list = []
      rootSlotIndices.set(slotKey, list)
    }
    list.push(idx)
  }

  /**
   * Child-session local rails (relative offsets):
   * - Each child band advances independently;
   * - Track `childSpan` so parent task slots can stretch to encompass nested work.
   */
  const childLocalXByIndex = new Map<number, number>()
  const childSpanByCallID = new Map<string, number>()
  for (const childSession of childKeys) {
    const callID = childSession.slice('session:task:'.length)
    const childIndices = sorted
      .map((a, idx) => ({ a, idx }))
      .filter((x) => x.a.source === 'child-session' && actionSessionKey(x.a) === childSession)
      .map((x) => x.idx)
    if (childIndices.length === 0) {
      childSpanByCallID.set(callID, 0)
      continue
    }
    const childSlotByIndex = new Map<number, string>()
    const childSlotOffsetByIndex = new Map<number, number>()
    const childGroupStepToSlot = new Map<string, Map<number, string>>()
    const childGroupLaneStepCounter = new Map<string, Map<number, number>>()
    let nextChildSlot = 0
    for (const idx of childIndices) {
      const a = sorted[idx]!
      let slotKey: string
      if (!a.parallelGroupId) {
        slotKey = `child:${nextChildSlot++}`
      } else {
        const groupKey = a.parallelGroupId
        const lane = a.parallelLaneIndex ?? 0
        let laneCounter = childGroupLaneStepCounter.get(groupKey)
        if (!laneCounter) {
          laneCounter = new Map<number, number>()
          childGroupLaneStepCounter.set(groupKey, laneCounter)
        }
        const step = laneCounter.get(lane) ?? 0
        laneCounter.set(lane, step + 1)
        let stepSlots = childGroupStepToSlot.get(groupKey)
        if (!stepSlots) {
          stepSlots = new Map<number, string>()
          childGroupStepToSlot.set(groupKey, stepSlots)
        }
        if (!stepSlots.has(step)) stepSlots.set(step, `child:${nextChildSlot++}`)
        slotKey = stepSlots.get(step)!
      }
      childSlotByIndex.set(idx, slotKey)
    }

    const childSlotWidth = new Map<string, number>()
    /** Duration mode: wall-clock spans per child slot to derive idle gaps */
    const childSlotTimeRange = new Map<string, { minStart: number; maxEnd: number }>()
    for (const idx of childIndices) {
      const slotKey = childSlotByIndex.get(idx)
      if (!slotKey) continue
      const a = sorted[idx]!
      const w = blockWidth(durationMode, a.durationMs)
      childSlotWidth.set(slotKey, Math.max(childSlotWidth.get(slotKey) ?? 0, w))
      if (durationMode) {
        const cur = childSlotTimeRange.get(slotKey)
        childSlotTimeRange.set(slotKey, {
          minStart: Math.min(cur?.minStart ?? Infinity, a.sortTime),
          maxEnd: Math.max(cur?.maxEnd ?? -Infinity, a.sortTime + Math.max(0, a.durationMs)),
        })
      }
    }
    if (durationMode) {
      childSlotWidth.clear()
      for (const idx of childIndices) {
        const slotKey = childSlotByIndex.get(idx)
        if (!slotKey) continue
        const a = sorted[idx]!
        const range = childSlotTimeRange.get(slotKey)
        const dx = durationStartOffsetPx(range?.minStart ?? a.sortTime, a.sortTime)
        childSlotOffsetByIndex.set(idx, dx)
        childSlotWidth.set(slotKey, Math.max(childSlotWidth.get(slotKey) ?? 0, dx + blockWidth(durationMode, a.durationMs)))
      }
    }
    const childSlotStartX = new Map<string, number>()
    let childCursor = 0
    for (let s = 0; s < nextChildSlot; s++) {
      const slotKey = `child:${s}`
      childSlotStartX.set(slotKey, childCursor)
      let interSlotGap = TIMELINE_STEP_GAP
      if (durationMode && s + 1 < nextChildSlot) {
        const nextKey = `child:${s + 1}`
        const thisRange = childSlotTimeRange.get(slotKey)
        const nextRange = childSlotTimeRange.get(nextKey)
        if (thisRange && nextRange) {
          const gapMs = Math.max(0, nextRange.minStart - thisRange.maxEnd)
          interSlotGap = durationGapWidthPx(gapMs)
        }
      }
      childCursor += (childSlotWidth.get(slotKey) ?? MIN_W) + interSlotGap
    }
    for (const idx of childIndices) {
      const slotKey = childSlotByIndex.get(idx)
      childLocalXByIndex.set(
        idx,
        (slotKey ? (childSlotStartX.get(slotKey) ?? 0) : 0) + (childSlotOffsetByIndex.get(idx) ?? 0),
      )
    }
    const lastChildGap = durationMode ? DUR_TAIL_PAD_PX : TIMELINE_STEP_GAP
    const childSpanRight = Math.max(0, childCursor - lastChildGap)
    childSpanByCallID.set(callID, childSpanRight)
  }

  /** Effective horizontal span per root slot: max(parent block, parent task→child-session footprint) */
  const rootSlotEffectiveSpan = new Map<string, number>()
  const rootSlotOffsetByIndex = new Map<number, number>()
  /** Duration mode: wall-clock ranges for each root slot (idle gap between slots) */
  const rootSlotTimeRange = new Map<string, { minStart: number; maxEnd: number }>()
  for (const [slotKey, indices] of rootSlotIndices.entries()) {
    let span = MIN_W
    let minStart = Infinity
    let maxEnd = -Infinity
    for (const idx of indices) {
      const a = sorted[idx]!
      const w = blockWidth(durationMode, a.durationMs)
      span = Math.max(span, w)
      if (a.actionType === 'Subagent' && a.source !== 'child-session' && a.callID) {
        const childSpan = childSpanByCallID.get(a.callID) ?? 0
        span = Math.max(span, w + TIMELINE_STEP_GAP + childSpan)
      }
      if (durationMode) {
        minStart = Math.min(minStart, a.sortTime)
        maxEnd = Math.max(maxEnd, a.sortTime + Math.max(0, a.durationMs))
      }
    }
    if (durationMode && Number.isFinite(minStart)) {
      rootSlotTimeRange.set(slotKey, { minStart, maxEnd })
    }
    if (durationMode && Number.isFinite(minStart)) {
      span = MIN_W
      for (const idx of indices) {
        const a = sorted[idx]!
        const dx = durationStartOffsetPx(minStart, a.sortTime)
        rootSlotOffsetByIndex.set(idx, dx)
        const w = blockWidth(durationMode, a.durationMs)
        span = Math.max(span, dx + w)
        if (a.actionType === 'Subagent' && a.source !== 'child-session' && a.callID) {
          const childSpan = childSpanByCallID.get(a.callID) ?? 0
          span = Math.max(span, dx + w + TIMELINE_STEP_GAP + childSpan)
        }
      }
    }
    rootSlotEffectiveSpan.set(slotKey, span)
  }

  const rootSlotStartX = new Map<string, number>()
  let rootCursor = MARGIN_LEFT
  for (let s = 0; s < nextRootSlot; s++) {
    const slotKey = `root:${s}`
    rootSlotStartX.set(slotKey, rootCursor)
    let interSlotGap = TIMELINE_STEP_GAP
    if (durationMode && s + 1 < nextRootSlot) {
      const nextKey = `root:${s + 1}`
      const thisRange = rootSlotTimeRange.get(slotKey)
      const nextRange = rootSlotTimeRange.get(nextKey)
      if (thisRange && nextRange) {
        const gapMs = Math.max(0, nextRange.minStart - thisRange.maxEnd)
        interSlotGap = durationGapWidthPx(gapMs)
      }
    }
    rootCursor += (rootSlotEffectiveSpan.get(slotKey) ?? MIN_W) + interSlotGap
  }
  for (const idx of rootIndices) {
    const slotKey = rootSlotByIndex.get(idx)
    if (!slotKey) continue
    actionXBySortedIndex.set(
      idx,
      (rootSlotStartX.get(slotKey) ?? MARGIN_LEFT) + (rootSlotOffsetByIndex.get(idx) ?? 0),
    )
  }

  /**
   * Post-fork branch rail: advances east from the fork anchor (+ gap), independent from the trunk axis.
   * Branch x must settle before aligning child-session x to the trailing edge of the forked Subagent.
   * - Shares the fork anchor’s starting x as post-anchor ghosts/new-branch divergence, vertically split into bands.
   * - Fallback to trunk right edge when no explicit anchor exists or ghosts are absent.
   */
  let forkBranchRight = MARGIN_LEFT
  if (hasNewBranchAction) {
    /** ① Resolve anchor’s right boundary on the trunk (anchors are historical rows with known root x). */
    let anchorRight: number | null = null
    if (forkAnchorActionKey) {
      for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i]!
        if (actionKey(a) === forkAnchorActionKey) {
          const x = actionXBySortedIndex.get(i)
          if (x != null) {
            const w = blockWidth(durationMode, a.durationMs)
            anchorRight = x + w
            /** If the anchor is a Subagent with a child session, branch rails must clear the child band to avoid overlay. */
            if (
              a.actionType === 'Subagent' &&
              a.source !== 'child-session' &&
              a.callID
            ) {
              const childSpan = childSpanByCallID.get(a.callID) ?? 0
              if (childSpan > 0) anchorRight = x + w + TIMELINE_STEP_GAP + childSpan
            }
          }
          break
        }
      }
    }
    if (anchorRight == null) {
      /** Fallback: rightmost non-fork action on the trunk (including nested child spans). */
      for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i]!
        if (isNewBranchAction(a)) continue
        const x = actionXBySortedIndex.get(i)
        if (x == null) continue
        let r = x + blockWidth(durationMode, a.durationMs)
        if (
          a.actionType === 'Subagent' &&
          a.source !== 'child-session' &&
          a.callID
        ) {
          const childSpan = childSpanByCallID.get(a.callID) ?? 0
          if (childSpan > 0) r = x + blockWidth(durationMode, a.durationMs) + TIMELINE_STEP_GAP + childSpan
        }
        if (anchorRight == null || r > anchorRight) anchorRight = r
      }
    }
    const forkBaseX = (anchorRight ?? MARGIN_LEFT) + TIMELINE_STEP_GAP

    /**
     * ② Branch indices = every `forkCompareRow === 2` action that is not `child-session`.
     *    Includes forked Subagents — they still key into `session:task:*` like pre-fork tasks,
     *    but must advance on the branch rail or they collide with historical slots.
     */
    const branchIndices = sorted
      .map((a, idx) => ({ a, idx }))
      .filter((x) => isNewBranchAction(x.a) && x.a.source !== 'child-session')
      .map((x) => x.idx)

    const branchSlotByIndex = new Map<number, string>()
    const branchSlotOffsetByIndex = new Map<number, number>()
    const branchSlotIndices = new Map<string, number[]>()
    const branchGroupStepToSlot = new Map<string, Map<number, string>>()
    const branchGroupLaneStepCounter = new Map<string, Map<number, number>>()
    let nextBranchSlot = 0
    for (const idx of branchIndices) {
      const a = sorted[idx]!
      let slotKey: string
      if (!a.parallelGroupId) {
        slotKey = `branch:${nextBranchSlot++}`
      } else {
        const groupKey = a.parallelGroupId
        const lane = a.parallelLaneIndex ?? 0
        let laneCounter = branchGroupLaneStepCounter.get(groupKey)
        if (!laneCounter) {
          laneCounter = new Map<number, number>()
          branchGroupLaneStepCounter.set(groupKey, laneCounter)
        }
        const step = laneCounter.get(lane) ?? 0
        laneCounter.set(lane, step + 1)
        let stepSlots = branchGroupStepToSlot.get(groupKey)
        if (!stepSlots) {
          stepSlots = new Map<number, string>()
          branchGroupStepToSlot.set(groupKey, stepSlots)
        }
        if (!stepSlots.has(step)) stepSlots.set(step, `branch:${nextBranchSlot++}`)
        slotKey = stepSlots.get(step)!
      }
      branchSlotByIndex.set(idx, slotKey)
      const arr = branchSlotIndices.get(slotKey) ?? []
      arr.push(idx)
      branchSlotIndices.set(slotKey, arr)
    }
    /** Branch-slot width must swallow nested forked Subagent sessions (same widening rule as the trunk rail). */
    const branchSlotEffectiveSpan = new Map<string, number>()
    /** Duration mode: per-branch-slot time span */
    const branchSlotTimeRange = new Map<string, { minStart: number; maxEnd: number }>()
    for (const [slotKey, indices] of branchSlotIndices.entries()) {
      let span = MIN_W
      let minStart = Infinity
      let maxEnd = -Infinity
      for (const idx of indices) {
        const a = sorted[idx]!
        const w = blockWidth(durationMode, a.durationMs)
        span = Math.max(span, w)
        if (a.actionType === 'Subagent' && a.source !== 'child-session' && a.callID) {
          const childSpan = childSpanByCallID.get(a.callID) ?? 0
          span = Math.max(span, w + TIMELINE_STEP_GAP + childSpan)
        }
        if (durationMode) {
          minStart = Math.min(minStart, a.sortTime)
          maxEnd = Math.max(maxEnd, a.sortTime + Math.max(0, a.durationMs))
        }
      }
      branchSlotEffectiveSpan.set(slotKey, span)
      if (durationMode && Number.isFinite(minStart)) {
        branchSlotTimeRange.set(slotKey, { minStart, maxEnd })
      }
      if (durationMode && Number.isFinite(minStart)) {
        span = MIN_W
        for (const idx of indices) {
          const a = sorted[idx]!
          const dx = durationStartOffsetPx(minStart, a.sortTime)
          branchSlotOffsetByIndex.set(idx, dx)
          const w = blockWidth(durationMode, a.durationMs)
          span = Math.max(span, dx + w)
          if (a.actionType === 'Subagent' && a.source !== 'child-session' && a.callID) {
            const childSpan = childSpanByCallID.get(a.callID) ?? 0
            span = Math.max(span, dx + w + TIMELINE_STEP_GAP + childSpan)
          }
        }
        branchSlotEffectiveSpan.set(slotKey, span)
      }
    }
    const branchSlotStartX = new Map<string, number>()
    let branchCursor = 0
    for (let s = 0; s < nextBranchSlot; s++) {
      const slotKey = `branch:${s}`
      branchSlotStartX.set(slotKey, branchCursor)
      let interSlotGap = TIMELINE_STEP_GAP
      if (durationMode && s + 1 < nextBranchSlot) {
        const nextKey = `branch:${s + 1}`
        const thisRange = branchSlotTimeRange.get(slotKey)
        const nextRange = branchSlotTimeRange.get(nextKey)
        if (thisRange && nextRange) {
          const gapMs = Math.max(0, nextRange.minStart - thisRange.maxEnd)
          interSlotGap = durationGapWidthPx(gapMs)
        }
      }
      branchCursor += (branchSlotEffectiveSpan.get(slotKey) ?? MIN_W) + interSlotGap
    }
    for (const idx of branchIndices) {
      const slotKey = branchSlotByIndex.get(idx)
      const localX = slotKey ? (branchSlotStartX.get(slotKey) ?? 0) : 0
      actionXBySortedIndex.set(idx, forkBaseX + localX + (branchSlotOffsetByIndex.get(idx) ?? 0))
    }
    const lastBranchGap = durationMode ? DUR_TAIL_PAD_PX : TIMELINE_STEP_GAP
    forkBranchRight = forkBaseX + Math.max(0, branchCursor - lastBranchGap)

    /**
     * Dual-rail synchronization: ghosts advance on trunk slots while the fork rail uses branch slots — two independent cursors.
     * Matching `TIMELINE_STEP_GAP` is not enough: differing `effectiveSpan` (duration or nested breadth) pushes ghost step k vs branch step k apart.
     *
     * Post-anchor unify: zip ghost-root slots with branch slots in order of appearance, force shared width = max(ghostSpan_k, branchSpan_k),
     * advance east from `forkBaseX`, rewriting `actionXBySortedIndex` for both rails. Absolute child-session x recomputes later from parent anchors.
     */
    const ghostRootSlots: { slotKey: string; firstSortTime: number }[] = []
    for (let s = 0; s < nextRootSlot; s++) {
      const slotKey = `root:${s}`
      const indices = rootSlotIndices.get(slotKey) ?? []
      if (indices.length === 0) continue
      if (indices.every((idx) => sorted[idx]!.forkGhost === true)) {
        let firstT = Infinity
        for (const idx of indices) {
          const t = sorted[idx]!.sortTime
          if (t < firstT) firstT = t
        }
        ghostRootSlots.push({ slotKey, firstSortTime: firstT })
      }
    }
    ghostRootSlots.sort((p, q) => p.firstSortTime - q.firstSortTime)

    const stepCount = Math.max(ghostRootSlots.length, nextBranchSlot)
    if (stepCount > 0) {
      let unifiedCursor = 0
      for (let k = 0; k < stepCount; k++) {
        let span = MIN_W
        if (k < ghostRootSlots.length) {
          span = Math.max(span, rootSlotEffectiveSpan.get(ghostRootSlots[k]!.slotKey) ?? MIN_W)
        }
        if (k < nextBranchSlot) {
          span = Math.max(span, branchSlotEffectiveSpan.get(`branch:${k}`) ?? MIN_W)
        }
        const stepX = forkBaseX + unifiedCursor
        if (k < ghostRootSlots.length) {
          const slotKey = ghostRootSlots[k]!.slotKey
          const indices = rootSlotIndices.get(slotKey) ?? []
          for (const idx of indices) {
            actionXBySortedIndex.set(idx, stepX + (rootSlotOffsetByIndex.get(idx) ?? 0))
          }
        }
        if (k < nextBranchSlot) {
          const slotKey = `branch:${k}`
          const indices = branchSlotIndices.get(slotKey) ?? []
          for (const idx of indices) {
            actionXBySortedIndex.set(idx, stepX + (branchSlotOffsetByIndex.get(idx) ?? 0))
          }
        }
        unifiedCursor += span + TIMELINE_STEP_GAP
      }
      forkBranchRight = forkBaseX + Math.max(0, unifiedCursor - TIMELINE_STEP_GAP)
    }
  }

  /**
   * Child-session absolute x = parent task trailing edge + gap + local offset inside the nested band.
   * **Runs after branch x assignment** — parent nodes on forks live on branch coordinates; otherwise lookups miss.
   */
  for (const childSession of childKeys) {
    const callID = childSession.slice('session:task:'.length)
    const parentIdx = sorted.findIndex(
      (a) => a.actionType === 'Subagent' && a.source !== 'child-session' && a.callID === callID
    )
    if (parentIdx < 0) continue
    const parent = sorted[parentIdx]!
    const parentX = actionXBySortedIndex.get(parentIdx) ?? MARGIN_LEFT
    const parentRight = parentX + blockWidth(durationMode, parent.durationMs)
    const childBaseX = parentRight + TIMELINE_STEP_GAP
    const childIndices = sorted
      .map((a, idx) => ({ a, idx }))
      .filter((x) => x.a.source === 'child-session' && actionSessionKey(x.a) === childSession)
      .map((x) => x.idx)
    for (const idx of childIndices) {
      actionXBySortedIndex.set(idx, childBaseX + (childLocalXByIndex.get(idx) ?? 0))
    }
  }

  syncParallelGroupHorizontalPositions(
    sorted,
    actionXBySortedIndex,
    childLocalXByIndex,
    durationMode,
  )

  /**
   * Terminator x placement per fork rail:
   *  - Main: trunk cursor reaches the farthest legacy action (nested child timelines included).
   *  - `fork-new-branch`: branch cursor + slack (`forkBranchRight` already nests forked Subagent spans).
   */
  let historicalRightmost = rootCursor - TIMELINE_STEP_GAP
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!
    if (isNewBranchAction(a)) continue
    const x = actionXBySortedIndex.get(i)
    if (x == null) continue
    const r = x + blockWidth(durationMode, a.durationMs)
    if (r > historicalRightmost) historicalRightmost = r
  }
  const endXMain = historicalRightmost + TIMELINE_STEP_GAP
  const branchRightmost = sorted.reduce((maxR, a, idx) => {
    if (!isNewBranchAction(a)) return maxR
    const x = actionXBySortedIndex.get(idx)
    if (x == null) return maxR
    return Math.max(maxR, x + blockWidth(durationMode, a.durationMs))
  }, MARGIN_LEFT)
  const endXForkBranch = hasNewBranchAction
    ? (durationMode ? branchRightmost + TIMELINE_STEP_GAP : forkBranchRight + TIMELINE_STEP_GAP)
    : endXMain

  const sessionTopY = new Map<string, number>()
  let sessionY = TOP_PAD
  for (const session of sessionOrder) {
    sessionTopY.set(session, sessionY)
    const local = sorted.filter((a) => actionSessionKey(a) === session)
    let maxBottom = BLOCK_H
    for (const a of local) {
      maxBottom = Math.max(maxBottom, verticalOffsetInSession(a) + BLOCK_H)
    }
    sessionY += maxBottom + SESSION_REGION_GAP
  }
  const totalH = Math.max(
    sessionY - SESSION_REGION_GAP + BOTTOM_PAD,
    TOP_PAD + BLOCK_H + BOTTOM_PAD,
    MIN_SVG_CONTENT_HEIGHT
  )

  const layout: FlowLayoutItem[] = []

  for (let i = 0; i < seq.length; i++) {
    const node = seq[i]!
    if (node.kind === 'end') {
      const w = MIN_W
      /**
       * Each fork rail anchors its terminator on the lane’s first toolbar row:
       *  - `sessionRegion='main'` — legacy terminator (solo mode / ghost closure)
       *  - `sessionRegion='fork-new-branch'` — new-track terminator
       */
      const isForkEnd = node.sessionRegion === 'fork-new-branch'
      const xNode = isForkEnd ? endXForkBranch : endXMain
      const regionKey = isForkEnd ? 'session:fork-new-branch' : 'session:main'
      const y = sessionTopY.get(regionKey) ?? sessionTopY.get('session:main') ?? TOP_PAD
      const cy = y + BLOCK_H / 2
      layout.push({ node, x: xNode, y, w, h: BLOCK_H, cx: xNode + w / 2, cy })
    } else {
      const a = node as MappedAction & { row: number }
      const w = blockWidth(durationMode, a.durationMs)
      const xNode = actionXBySortedIndex.get(i) ?? MARGIN_LEFT
      const session = actionSessionKey(a)
      const yBase = sessionTopY.get(session) ?? TOP_PAD
      const y = yBase + verticalOffsetInSession(a)
      const cy = y + BLOCK_H / 2
      layout.push({ node, x: xNode, y, w, h: BLOCK_H, cx: xNode + w / 2, cy })
    }
  }

  const maxActionRight = sorted.reduce((maxR, a, idx) => {
    const x = actionXBySortedIndex.get(idx) ?? MARGIN_LEFT
    const w = blockWidth(durationMode, a.durationMs)
    return Math.max(maxR, x + w)
  }, MARGIN_LEFT)
  const totalTimelineRight = includeEndNode
    ? Math.max(maxActionRight, endXMain + MIN_W, endXForkBranch + MIN_W)
    : maxActionRight
  const totalW = Math.max(totalTimelineRight + MARGIN_LEFT, 360)
  return { layout, totalW, totalH }
}

function parallelSiblingSkip(pa: MappedAction, pb: MappedAction): boolean {
  if (!pa.parallelGroupId || !pb.parallelGroupId) return false
  if (pa.parallelGroupId !== pb.parallelGroupId) return false
  if (pa.parallelLaneIndex === undefined || pb.parallelLaneIndex === undefined) return false
  return pa.parallelLaneIndex !== pb.parallelLaneIndex
}

/** Minimum eastward clearance before turning toward the target (duration wide blocks may sit left of slot cursor). */
const EDGE_ROUTE_GAP = 10

function userRequestCircleRadius(w: number, h: number): number {
  return Math.max(5, Math.min(w, h) / 2 - 3)
}

function endNodeCircleRadius(h: number): number {
  return h / 2 - 2
}

/** Visual right anchor for connectors (rect trailing edge or circle circumference). */
function edgeAnchorRight(item: FlowLayoutItem): number {
  if (item.node.kind === 'end') {
    return item.x + item.w / 2 + endNodeCircleRadius(item.h)
  }
  const act = item.node as MappedAction & { row: number }
  if (act.actionType === 'UserRequest') {
    const r = userRequestCircleRadius(item.w, item.h)
    return item.x + item.w / 2 + r
  }
  return item.x + item.w
}

/** Visual left anchor for connectors. */
function edgeAnchorLeft(item: FlowLayoutItem): number {
  if (item.node.kind === 'end') {
    return item.x + item.w / 2 - endNodeCircleRadius(item.h)
  }
  const act = item.node as MappedAction & { row: number }
  if (act.actionType === 'UserRequest') {
    const r = userRequestCircleRadius(item.w, item.h)
    return item.x + item.w / 2 - r
  }
  return item.x
}

function orthoEdgePathD(x1: number, y1: number, x2: number, y2: number): string {
  if (x2 >= x1 + EDGE_ROUTE_GAP) {
    const mid = (x1 + x2) / 2
    const path = d3.path()
    path.moveTo(x1, y1)
    path.lineTo(mid, y1)
    path.lineTo(mid, y2)
    path.lineTo(x2, y2)
    return path.toString()
  }
  const bypassX = x1 + EDGE_ROUTE_GAP
  const path = d3.path()
  path.moveTo(x1, y1)
  path.lineTo(bypassX, y1)
  path.lineTo(bypassX, y2)
  path.lineTo(x2, y2)
  return path.toString()
}

function appendOrthoEdgeBetweenItems(
  content: d3.Selection<SVGGElement, unknown, null, undefined>,
  from: FlowLayoutItem,
  to: FlowLayoutItem,
  markerUrl: string,
  stroke: string,
  strokeWidth: number,
  fromKey: string | null = null,
  toKey: string | null = null,
) {
  appendOrthoEdge(
    content,
    edgeAnchorRight(from),
    from.cy,
    edgeAnchorLeft(to),
    to.cy,
    markerUrl,
    stroke,
    strokeWidth,
    fromKey,
    toKey,
  )
}

/**
 * Single predecessor fans out to parallel successors via one shared bundle column so vertical segments overlap cleanly.
 * - Draw the trunk horizontally once (no arrow head).
 * - Emit one branch polyline per target ending with arrow heads.
 */
function appendOrthoFanOut(
  content: d3.Selection<SVGGElement, unknown, null, undefined>,
  source: FlowLayoutItem,
  targets: FlowLayoutItem[],
  markerUrl: string,
  ghostMarkerUrl: string
) {
  if (targets.length === 0) return
  const sna = source.node.kind === 'action' ? (source.node as MappedAction & { row: number }) : null
  const baseStroke = sna?.forkGhost ? FORK_GHOST_STROKE : actionFlowPalette.arrow
  const baseMarker = sna?.forkGhost ? ghostMarkerUrl : markerUrl

  if (targets.length === 1) {
    const t = targets[0]!
    appendOrthoEdgeBetweenItems(content, source, t, baseMarker, baseStroke, 1.2,
      sna ? actionKey(sna) : null,
      t.node.kind === 'action' ? actionKey(t.node as MappedAction & { row: number }) : null)
    return
  }

  const sourceRight = edgeAnchorRight(source)
  const minTargetLeft = Math.min(...targets.map((t) => edgeAnchorLeft(t)))
  const bundleX =
    minTargetLeft >= sourceRight + EDGE_ROUTE_GAP
      ? (sourceRight + minTargetLeft) / 2
      : sourceRight + EDGE_ROUTE_GAP

  /** Trunk: source.right → bundleX (single segment, avoids stacked arrow markers on one x). */
  const trunk = d3.path()
  trunk.moveTo(sourceRight, source.cy)
  trunk.lineTo(bundleX, source.cy)
  const tp = content
    .append('path')
    .attr('class', 'afv-edge')
    .attr('d', trunk.toString())
    .attr('fill', 'none')
    .attr('stroke', baseStroke)
    .attr('stroke-width', 1.2)
    .attr('pointer-events', 'none')
  if (sna) tp.attr('data-from-key', actionKey(sna))

  /** Branches: (bundleX, source.cy) → (bundleX, target.cy) → (target.x, target.cy) with arrow markers */
  for (const t of targets) {
    const tna = t.node.kind === 'action' ? (t.node as MappedAction & { row: number }) : null
    const stroke = tna?.forkGhost ? FORK_GHOST_STROKE : baseStroke
    const m = tna?.forkGhost ? ghostMarkerUrl : baseMarker
    const branch = d3.path()
    const targetLeft = edgeAnchorLeft(t)
    branch.moveTo(bundleX, source.cy)
    branch.lineTo(bundleX, t.cy)
    branch.lineTo(targetLeft, t.cy)
    const bp = content
      .append('path')
      .attr('class', 'afv-edge')
      .attr('d', branch.toString())
      .attr('fill', 'none')
      .attr('stroke', stroke)
      .attr('stroke-width', 1.2)
      .attr('marker-end', m)
      .attr('pointer-events', 'none')
    if (sna) bp.attr('data-from-key', actionKey(sna))
    if (tna) bp.attr('data-to-key', actionKey(tna))
  }
}

function appendOrthoEdge(
  content: d3.Selection<SVGGElement, unknown, null, undefined>,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  markerUrl: string,
  stroke: string,
  strokeWidth: number,
  /** Link metadata: originating / terminating action keys (null for synthetic end nodes). */
  fromKey: string | null = null,
  toKey: string | null = null
) {
  const p = content
    .append('path')
    .attr('class', 'afv-edge')
    .attr('d', orthoEdgePathD(x1, y1, x2, y2))
    .attr('fill', 'none')
    .attr('stroke', stroke)
    .attr('stroke-width', strokeWidth)
    .attr('marker-end', markerUrl)
    /** Disable pointer hits so rects/context menus remain reachable under edges */
    .attr('pointer-events', 'none')
  if (fromKey) p.attr('data-from-key', fromKey)
  if (toKey) p.attr('data-to-key', toKey)
}

function joinStrokeForFanIn(
  from: MappedAction & { row: number },
  to: FlowNode,
  markerUrl: string,
  ghostMarkerUrl: string
): { stroke: string; markerUrl: string } {
  if (to.kind === 'end') {
    return {
      stroke: from.forkGhost ? FORK_GHOST_STROKE : actionFlowPalette.arrow,
      markerUrl: from.forkGhost ? ghostMarkerUrl : markerUrl,
    }
  }
  return edgeStrokeAndMarker(from, to as MappedAction & { row: number }, markerUrl, ghostMarkerUrl)
}

/**
 * Many edges converge on one successor via a vertical spine at bundleX halfway between predecessors and target.
 */
function appendOrthoFanIn(
  content: d3.Selection<SVGGElement, unknown, null, undefined>,
  sources: FlowLayoutItem[],
  target: FlowLayoutItem,
  markerUrl: string,
  ghostMarkerUrl: string
) {
  if (sources.length === 0) return
  const targetKey =
    target.node.kind === 'action'
      ? actionKey(target.node as MappedAction & { row: number })
      : null
  if (sources.length === 1) {
    const s = sources[0]!
    const na = s.node as MappedAction & { row: number }
    const { stroke, markerUrl: m } = joinStrokeForFanIn(na, target.node, markerUrl, ghostMarkerUrl)
    appendOrthoEdgeBetweenItems(content, s, target, m, stroke, 1.2, actionKey(na), targetKey)
    return
  }
  /**
   * Fan-in merges parallel feeder edges into one shared trunk:
   * - Feeders omit arrow heads but keep per-edge stroke semantics.
   * - Exactly one downstream trunk segment renders the arrow to avoid stacking N markers.
   * - Trunk tint follows the dominant non-ghost feeder when possible so the terminator reads clean.
   */
  const maxEnd = Math.max(...sources.map((s) => edgeAnchorRight(s)))
  const targetLeft = edgeAnchorLeft(target)
  const bundleX =
    targetLeft >= maxEnd + EDGE_ROUTE_GAP
      ? (maxEnd + targetLeft) / 2
      : maxEnd + EDGE_ROUTE_GAP

  for (const s of sources) {
    const na = s.node as MappedAction & { row: number }
    const { stroke } = joinStrokeForFanIn(na, target.node, markerUrl, ghostMarkerUrl)
    const path = d3.path()
    path.moveTo(edgeAnchorRight(s), s.cy)
    path.lineTo(bundleX, s.cy)
    path.lineTo(bundleX, target.cy)
    const p = content
      .append('path')
      .attr('class', 'afv-edge')
      .attr('d', path.toString())
      .attr('fill', 'none')
      .attr('stroke', stroke)
      .attr('stroke-width', 1.2)
      .attr('pointer-events', 'none')
      .attr('data-from-key', actionKey(na))
    if (targetKey) p.attr('data-to-key', targetKey)
  }

  const trunkSource =
    sources.find((s) => (s.node as MappedAction & { row: number }).forkGhost !== true) ??
    sources[0]!
  const trunkNa = trunkSource.node as MappedAction & { row: number }
  const { stroke: trunkStroke, markerUrl: trunkMarker } = joinStrokeForFanIn(
    trunkNa,
    target.node,
    markerUrl,
    ghostMarkerUrl,
  )
  const trunk = d3.path()
  trunk.moveTo(bundleX, target.cy)
  trunk.lineTo(targetLeft, target.cy)
  const tp = content
    .append('path')
    .attr('class', 'afv-edge')
    .attr('d', trunk.toString())
    .attr('fill', 'none')
    .attr('stroke', trunkStroke)
    .attr('stroke-width', 1.2)
    .attr('marker-end', trunkMarker)
    .attr('pointer-events', 'none')
  if (targetKey) tp.attr('data-to-key', targetKey)
}

interface Props {
  actions: (MappedAction & { row: number })[]
  durationMode: boolean
  colorMode: 'status' | 'tokens' | 'type'
  /**
   * Duration emphasis: keep full opacity while `durationMs >= durationHighlightMinMs`;
   * shorter actions fade (independent of color mode).
   */
  durationHighlightMinMs?: number | null
  /** Token emphasis: keep opacity while `tokenEstimate >= tokenHighlightMin`. */
  tokenHighlightMin?: number | null
  /** When thresholds apply, auto-scroll to first matching block (default true). */
  autoScrollFirstFilteredMatch?: boolean
  /**
   * Message table backing tooltips: merge of `segmentMessages` + `childBranchMessages`
   * (see `mergeMessagesForActionTooltipLookup`) so `partId` aligns with rects.
   */
  tooltipMessages?: OcMessage[]
  onForkFromAction?: (action: MappedAction & { row: number }) => void
  onAnalyzeFromAction?: (action: MappedAction & { row: number }) => void
  /** Mock-data only: synthetically split the flow at an action index */
  mockBranchForkActionIndex?: number
  /**
   * When false, skip the closing end node (still useful while tools are running/pending).
   * Defaults to true.
   */
  showFlowEndNode?: boolean
  /** Hover HTML for the terminator; pair with `showFlowEndNode`. */
  flowEndSummary?: FlowEndSummary
  /** Drop inner chrome when embedded inside split containers */
  embedded?: boolean
  /** Cap scroll area height (px) for stacked lanes */
  viewportMaxHeight?: number
  /**
   * Hide scrollbars via CSS while keeping wheel scrolling. Default false — shows native overflow affordance.
   */
  hideScrollbar?: boolean
  /** Type-level highlight: matching groups stay bright, others fade. */
  highlightedActionType?: string | null
  /**
   * Action-level highlight (single `actionKey`), higher priority than type mode.
   */
  highlightedActionKey?: string | null
  /** Dim the entire flow while another subtask owns focus */
  dimAll?: boolean
  /** Rectangle click toggles action-level selection */
  onSelectAction?: (actionKey: string | null) => void
  /**
   * Fork-compare: pass the anchor `actionKey()` for `forkCompareRow === 2` rows — layout allocates a branch rail east of the anchor with dedicated drop edges.
   */
  forkAnchorActionKey?: string | null
  /** Palette id when `colorMode === 'type'` */
  actionTypePaletteId?: ActionTypePaletteId
}

export default function ActionFlowVisualization({
  actions,
  durationMode,
  colorMode,
  durationHighlightMinMs = null,
  tokenHighlightMin = null,
  autoScrollFirstFilteredMatch = true,
  tooltipMessages,
  onForkFromAction,
  onAnalyzeFromAction,
  mockBranchForkActionIndex,
  showFlowEndNode = true,
  flowEndSummary,
  embedded = false,
  viewportMaxHeight,
  hideScrollbar = false,
  highlightedActionType = null,
  highlightedActionKey = null,
  dimAll = false,
  onSelectAction,
  forkAnchorActionKey = null,
  actionTypePaletteId = DEFAULT_ACTION_TYPE_PALETTE_ID,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [contextMenu, setContextMenu] = useState<ActionFlowContextMenuState | null>(null)
  const reactId = useId().replace(/:/g, '')
  const markerId = `action-flow-arrow-${reactId}`
  const tooltipId = `action-flow-tip-${reactId}`
  /**
   * react-tooltip v5 performs its initial DOM scan inside `useEffect` (after paint) while D3 renders in `useLayoutEffect`.
   * In practice tooltip’s `[anchorsBySelect, activeAnchor]` handler fires right after scanning, resetting observers;
   * if the mouse already hovers during that teardown window `mouseenter` may never register.
   * Mount tooltips after the first paint batch so anchors exist before the observer spins up.
   */
  const [tooltipMounted, setTooltipMounted] = useState(false)
  useEffect(() => {
    setTooltipMounted(true)
  }, [])
  const layoutEstimate = useMemo(
    () =>
      computeLayout(actions, durationMode, {
        includeEndNode: showFlowEndNode,
        forkAnchorActionKey,
      }),
    [actions, durationMode, showFlowEndNode, forkAnchorActionKey]
  )

  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const root = d3.select(svg)
    root.selectAll('*').remove()

    const maxTok = Math.max(1, ...actions.map(a => a.tokenEstimate))
    const colorScale = d3.scaleSequential(d3.interpolateBlues).domain([0, maxTok])

    const { layout, totalW, totalH } = computeLayout(actions, durationMode, {
      includeEndNode: showFlowEndNode,
      forkAnchorActionKey,
    })
    /** Fork compare when any forked-branch action appears (tasks included). Cannot rely solely on `session:fork-new-branch` because forked Subagents still key child sessions differently. */
    const hasForkNewBranchInLayout = layout.some(
      (item) =>
        item.node.kind === 'action' &&
        isNewBranchAction(item.node as MappedAction & { row: number }),
    )
    const offsetY = verticalCenterOffsetY(layout, totalH)
    const durationFilterActive =
      durationHighlightMinMs != null && Number.isFinite(durationHighlightMinMs)
    const tokenFilterActive =
      tokenHighlightMin != null && Number.isFinite(tokenHighlightMin)
    const filterMode = durationFilterActive ? 'duration' : tokenFilterActive ? 'tokens' : null

    const defs = root.append('defs')
    defs
      .append('marker')
      .attr('id', markerId)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 8)
      .attr('refY', 0)
      .attr('markerWidth', 5)
      .attr('markerHeight', 5)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', actionFlowPalette.arrow)

    const markerUrl = `url(#${markerId})`
    const ghostMarkerId = `action-flow-arrow-ghost-${reactId}`
    const ghostMarkerUrl = `url(#${ghostMarkerId})`
    defs
      .append('marker')
      .attr('id', ghostMarkerId)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 8)
      .attr('refY', 0)
      .attr('markerWidth', 5)
      .attr('markerHeight', 5)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', FORK_GHOST_MARKER_FILL)

    const canMockFork =
      typeof mockBranchForkActionIndex === 'number' &&
      mockBranchForkActionIndex >= 0 &&
      mockBranchForkActionIndex < actions.length
    const extraTopRows = canMockFork ? 1 : 0
    const topOffset = extraTopRows * ROW_H

    const content = root.append('g').attr('transform', `translate(0, ${offsetY + topOffset})`)
    const contentNode = content.node() as SVGGElement | null
    const edgeExists = (fromKey: string, toKey: string): boolean => {
      if (!contentNode) return false
      const esc = (s: string) =>
        typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"')
      return Boolean(
        contentNode.querySelector(
          `path.afv-edge[data-from-key="${esc(fromKey)}"][data-to-key="${esc(toKey)}"]`,
        ),
      )
    }

    /** Skip sequential segments already handled inside `appendOrthoFanIn`. */
    const parallelJoinSkip = new Set<string>()
    /** Parallel fan-outs render via `appendOrthoFanOut` — omit duplicates from primary loop */
    const parallelFanOutSkip = new Set<string>()

    /** Parallel bundles: intra-lane links, predecessor→lane heads, tails→successor (merged fan-in/out). */
    const groupIdToIndices = new Map<string, number[]>()
      for (let i = 0; i < layout.length; i++) {
        const item = layout[i]!
        if (item.node.kind !== 'action') continue
        const act = item.node as MappedAction & { row: number }
        const gid = act.parallelGroupId
        if (!gid) continue
        let arr = groupIdToIndices.get(gid)
        if (!arr) {
          arr = []
          groupIdToIndices.set(gid, arr)
        }
        arr.push(i)
      }
      for (const indices of groupIdToIndices.values()) {
      if (indices.length < 2) continue
      const groupActions = indices.map((idx) => ({
        idx,
        node: layout[idx]!.node as MappedAction & { row: number },
      }))
      const groupMinT = Math.min(...groupActions.map((g) => g.node.sortTime))
      const groupMaxT = Math.max(...groupActions.map((g) => g.node.sortTime))
      const indexSet = new Set(indices)

      /**
       * Which session hosts parallel predecessors/successors.
       *
       * Parallel Subagent rects key `session:task:callID` even though predecessors live in `session:main`.
       * Filtering strictly by the group session would drop real edges — only one adjacent edge would survive.
       *
       * Resolution:
       * - Subagent originating outside child sessions → search `'session:main'` (nested parents use parentTask anchors)
       * - Parallel actions inside child sessions → `'session:task:<parentTaskCallID>'`
       * - Ordinary main-band actions → `actionSessionKey`
       *
       * Still respect fork partitions (ghost vs new-branch) separately.
       */
      const firstNode = groupActions[0]!.node
      const groupIsGhost = firstNode.forkGhost === true
      const groupIsNewBranch = isNewBranchAction(firstNode)

      /** Session owning pred/succ search */
      const groupSearchSession: string = (() => {
        if (
          firstNode.actionType === 'Subagent' &&
          firstNode.source !== 'child-session' &&
          firstNode.callID &&
          firstNode.childSessionID
        ) {
          return 'session:main'
        }
        return actionSessionKey(firstNode)
      })()

      /** Fork boundary predicate for this parallel bundle */
      const passForkBoundary = (na: MappedAction & { row: number }): boolean => {
        if (groupIsGhost) return na.forkGhost === true
        if (groupIsNewBranch) return isNewBranchAction(na)
        return na.forkGhost !== true && !isNewBranchAction(na)
      }

      let predItem: (typeof layout)[0] | undefined
      let predIdx = -1
      for (let i = 0; i < layout.length; i++) {
        if (indexSet.has(i)) continue
        const it = layout[i]!
        if (it.node.kind !== 'action') continue
        const na = it.node as MappedAction & { row: number }
        if (actionSessionKey(na) !== groupSearchSession) continue
        if (!passForkBoundary(na)) continue
        if (na.sortTime < groupMinT) {
          predItem = it
          predIdx = i
        }
      }

      let succItem: (typeof layout)[0] | undefined
      let succIdx = -1
      for (let i = 0; i < layout.length; i++) {
        if (indexSet.has(i)) continue
        const it = layout[i]!
        if (it.node.kind !== 'action') continue
        const na = it.node as MappedAction & { row: number }
        if (actionSessionKey(na) !== groupSearchSession) continue
        if (!passForkBoundary(na)) continue
        if (na.sortTime > groupMaxT) {
          succItem = it
          succIdx = i
          break
        }
      }
      if (succIdx < 0) {
        /**
         * When no explicit successor exists, wire each bundle to its matching terminator:
         *  - Vanilla mode: lone `session:main` end
         *  - Fork compare: main bundle → ghost end, fork bundle → fork end
         */
        for (let i = 0; i < layout.length; i++) {
          if (indexSet.has(i)) continue
          const it = layout[i]!
          if (it.node.kind !== 'end') continue
          const endRegion =
            it.node.sessionRegion === 'fork-new-branch'
              ? 'session:fork-new-branch'
              : 'session:main'
          const targetEndRegion = groupIsNewBranch ? 'session:fork-new-branch' : 'session:main'
          if (endRegion === targetEndRegion) {
            succItem = it
            succIdx = i
            break
          }
        }
      }

      const byLane = new Map<number, number[]>()
      for (const idx of indices) {
        const act = layout[idx]!.node as MappedAction & { row: number }
        const lane = act.parallelLaneIndex ?? 0
        let list = byLane.get(lane)
        if (!list) {
          list = []
          byLane.set(lane, list)
        }
        list.push(idx)
      }

      const firstIndices: number[] = []
      const lastIndices: number[] = []
      for (const laneIndices of byLane.values()) {
        const sortedIdx = [...laneIndices].sort((a, b) => {
          const ta = (layout[a]!.node as MappedAction & { row: number }).sortTime
          const tb = (layout[b]!.node as MappedAction & { row: number }).sortTime
          return ta - tb
        })
        /** Intra-lane sequential connectors */
        for (let i = 0; i < sortedIdx.length - 1; i++) {
          const fromIdx = sortedIdx[i]!
          const toIdx = sortedIdx[i + 1]!
          const na = layout[fromIdx]!.node as MappedAction & { row: number }
          const nb = layout[toIdx]!.node as MappedAction & { row: number }
          const { stroke: forkStroke, markerUrl: forkMarker } = edgeStrokeAndMarker(na, nb, markerUrl, ghostMarkerUrl)
          appendOrthoEdgeBetweenItems(
            content,
            layout[fromIdx]!,
            layout[toIdx]!,
            forkMarker,
            forkStroke,
            1.2,
            actionKey(na),
            actionKey(nb),
          )
        }
        firstIndices.push(sortedIdx[0]!)
        lastIndices.push(sortedIdx[sortedIdx.length - 1]!)
      }

      /**
       * Fan-out predecessor → lane heads via `appendOrthoFanOut`, register each pred→first skip token for the sequential pass.
       */
      if (predItem && predIdx >= 0 && firstIndices.length > 0) {
        for (const fi of firstIndices) {
          parallelFanOutSkip.add(`${predIdx}-${fi}`)
        }
        appendOrthoFanOut(
          content,
          predItem,
          firstIndices.map((fi) => layout[fi]!),
          markerUrl,
          ghostMarkerUrl
        )
      }

      /** Fan-in lane tails → successor using shared bundle column */
      if (succItem && succIdx >= 0 && lastIndices.length > 0) {
        for (const li of lastIndices) {
          parallelJoinSkip.add(`${li}-${succIdx}`)
        }
        appendOrthoFanIn(
          content,
          lastIndices.map((idx) => layout[idx]!),
          layout[succIdx]!,
          markerUrl,
          ghostMarkerUrl
        )
      }
    }

    /**
     * Post-fork rails (ghost tails vs forked timeline) interleave sortTime — sequential adjacency is unsafe.
     * `connectPostAnchorTrack` restores edges by scanning each rail independently.
     */
    const isPostAnchor = (a: MappedAction & { row: number }) =>
      a.forkGhost === true || isNewBranchAction(a)

    for (let i = 0; i < layout.length - 1; i++) {
      const a = layout[i]!
      const b = layout[i + 1]!
      if (a.node.kind === 'action' && b.node.kind === 'action') {
        const pa = a.node as MappedAction & { row: number }
        const pb = b.node as MappedAction & { row: number }
        /**
         * Skip sequential neighbors between rails after the fork anchor — mis-paired adjacency skips true successors (`connectPostAnchorTrack` redraws separately).
         */
        if (isPostAnchor(pa) && isPostAnchor(pb)) continue
        /**
         * Skip pseudo-adjacency across legacy ghosts vs fork branch (anchor linkage handled explicitly).
         */
        const aIsNewBranch = isNewBranchAction(pa)
        const bIsNewBranch = isNewBranchAction(pb)
        if (aIsNewBranch !== bIsNewBranch) continue
        if (
          pa.actionType === 'Subagent' &&
          pa.childSessionID &&
          pa.callID &&
          pb.source === 'child-session' &&
          pb.parentTaskCallID === pa.callID &&
          pb.branchChildSessionID === pa.childSessionID
        ) {
          continue
        }
        if (parallelSiblingSkip(pa, pb)) continue
      }
      if (parallelJoinSkip.has(`${i}-${i + 1}`)) continue
      if (parallelFanOutSkip.has(`${i}-${i + 1}`)) continue
      /**
       * Skip implicit hops into terminator nodes — dedicated closing pass attaches each lane’s trailing action correctly.
       */
      if (b.node.kind === 'end') continue
      const { stroke: segStroke, markerUrl: segMarker } =
        a.node.kind === 'action' && b.node.kind === 'action'
          ? edgeStrokeAndMarker(
              a.node as MappedAction & { row: number },
              b.node as MappedAction & { row: number },
              markerUrl,
              ghostMarkerUrl
            )
          : { stroke: actionFlowPalette.arrow, markerUrl }
      const fromKey =
        a.node.kind === 'action' ? actionKey(a.node as MappedAction & { row: number }) : null
      const toKey =
        b.node.kind === 'action' ? actionKey(b.node as MappedAction & { row: number }) : null
      appendOrthoEdgeBetweenItems(content, a, b, segMarker, segStroke, 1.2, fromKey, toKey)
    }

    /**
     * Stitch same-rail actions post-fork sorted by `sortTime`.
     * - Ghost stack (`forkGhost`) vs fork stack (`forkCompareRow === 2`) stay independent.
     * - Inside a rail ignore session distinctions (reads like pre-fork Main→Subagent flow).
     * - Skip purple Subagent→child entry edges, intra-parallel siblings, and fan-in pairs already routed.
     */
    const connectPostAnchorTrack = (
      predicate: (a: MappedAction & { row: number }) => boolean,
    ) => {
      const indices: number[] = []
      for (let i = 0; i < layout.length; i++) {
        const it = layout[i]!
        if (it.node.kind !== 'action') continue
        if (!predicate(it.node as MappedAction & { row: number })) continue
        indices.push(i)
      }
      indices.sort((p, q) => {
        const ta = (layout[p]!.node as MappedAction & { row: number }).sortTime
        const tb = (layout[q]!.node as MappedAction & { row: number }).sortTime
        return ta - tb
      })
      for (let k = 0; k < indices.length - 1; k++) {
        const i = indices[k]!
        const j = indices[k + 1]!
        const ai = layout[i]!
        const bi = layout[j]!
        const pa = ai.node as MappedAction & { row: number }
        const pb = bi.node as MappedAction & { row: number }
        if (
          pa.actionType === 'Subagent' &&
          pa.childSessionID &&
          pa.callID &&
          pb.source === 'child-session' &&
          pb.parentTaskCallID === pa.callID &&
          pb.branchChildSessionID === pa.childSessionID
        ) {
          continue
        }
        if (parallelSiblingSkip(pa, pb)) continue
        if (parallelJoinSkip.has(`${i}-${j}`)) continue
        const { stroke, markerUrl: m } = edgeStrokeAndMarker(pa, pb, markerUrl, ghostMarkerUrl)
        appendOrthoEdgeBetweenItems(content, ai, bi, m, stroke, 1.2, actionKey(pa), actionKey(pb))
      }
    }
    connectPostAnchorTrack((a) => a.forkGhost === true)
    connectPostAnchorTrack(isNewBranchAction)

    layout.forEach((item, layoutIndex) => {
      const { node, x: nx, y: ny, w, h } = item
      if (node.kind === 'end') {
        /**
         * Ghost terminator (`sessionRegion='main'` with active fork rails) renders neutral grey;
         * forked / baseline ends keep `palette.end` yellow. Omit summary tooltip on ghosts (current-session data mismatch).
         */
        const isGhostEnd =
          node.sessionRegion === 'main' && hasForkNewBranchInLayout
        const fill = isGhostEnd ? '#E8E8E8' : actionFlowPalette.end.fill
        const stroke = isGhostEnd ? '#BFBFBF' : actionFlowPalette.end.stroke
        const endTip = !isGhostEnd && flowEndSummary ? buildFlowEndTooltipHtml(flowEndSummary) : ''
        const circle = content
          .append('circle')
          .attr('cx', nx + w / 2)
          .attr('cy', ny + h / 2)
          .attr('r', h / 2 - 2)
          .attr('fill', fill)
          .attr('stroke', stroke)
          .attr('stroke-width', 1.5)
          .style('cursor', endTip ? 'pointer' : 'default')
        if (endTip) {
          circle.attr('data-tooltip-id', tooltipId).attr('data-tooltip-html', endTip).attr('data-tooltip-place', 'left')
        }
        return
      }

      const act = node as MappedAction & { row: number }
      const isGhost = act.forkGhost === true
      const isUserRequest = act.actionType === 'UserRequest'
      const matchesHighlight =
        filterMode === null
          ? true
          : filterMode === 'duration'
            ? !Number.isFinite(act.durationMs) || act.durationMs >= (durationHighlightMinMs as number)
            : !Number.isFinite(act.tokenEstimate) || act.tokenEstimate >= (tokenHighlightMin as number)
      const sc = effectiveStatusColors(act.status, act.durationMs)
      const { fill, iconFill } = resolveActionBlockColors(
        act,
        colorMode,
        colorScale,
        actionTypePaletteId,
      )

      let stateOutlineStroke = 'none'
      let stateOutlineStrokeW = 0
      if (!isGhost && !isUserRequest) {
        if (act.status === 'running' || act.status === 'pending') {
          stateOutlineStroke = statusColors(act.status).stroke
          stateOutlineStrokeW = 1.75
        }
      }

      /** Each action mounts a `<g>` with tooltip + dim metadata keyed by action type/key */
      const ak = actionKey(act)
      const actionG = content
        .append('g')
        .attr('class', 'afv-action')
        .attr('data-action-type', act.actionType)
        .attr('data-action-key', ak)
        .style('opacity', '1')
      const actionTarget = (isUserRequest
        ? actionG
            .append('circle')
            .attr('cx', nx + w / 2)
            .attr('cy', ny + h / 2)
            .attr('r', Math.max(5, Math.min(w, h) / 2 - 3))
            .attr('fill', 'transparent')
            .attr('stroke', iconFill)
            .attr('stroke-width', 2)
        : actionG
            .append('rect')
            .attr('x', nx)
            .attr('y', ny)
            .attr('width', w)
            .attr('height', h)
            .attr('rx', Math.max(1.5, Math.min(4, Math.min(w, h) * 0.22)))
            .attr('fill', fill)
            .attr('stroke', stateOutlineStroke)
            .attr('stroke-width', stateOutlineStrokeW)) as unknown as d3.Selection<
        SVGGraphicsElement,
        unknown,
        null,
        undefined
      >
      actionTarget
        .style('cursor', 'pointer')
        /**
         * `UserRequest` uses a hollow circle — default hit-testing ignores transparent interiors, breaking tooltips centered on the ring.
         */
        .attr('pointer-events', 'all')
        .attr('data-tooltip-id', tooltipId)
        .attr('data-tooltip-html', buildCompactMappedActionTooltipHtml(act, tooltipMessages, formatDurationMs))
        .attr('data-tooltip-place', 'top')
      if (onSelectAction) {
        actionTarget.on('click', (ev: MouseEvent) => {
          ev.stopPropagation()
          onSelectAction(ak)
        })
      }
      /** Persist filter dim flags so reused DOM nodes do not flicker stale opacity */
      actionG.attr('data-filter-dim', matchesHighlight ? '0' : '1')
      const canContext =
        act.messageID && (onForkFromAction || onAnalyzeFromAction) && act.forkGhost !== true
      const actionTargetEl = actionTarget.node() as SVGGraphicsElement
      if (canContext) {
        actionTarget.on('contextmenu', (ev: Event) => {
          ev.preventDefault()
          ev.stopPropagation()
          setContextMenu({ anchorRect: actionTargetEl.getBoundingClientRect(), action: act })
        })
      }

      if (
        !isGhost &&
        !isUserRequest &&
        (act.status === 'running' || act.status === 'pending')
      ) {
        actionTarget.attr('class', sc.isLongRunning ? 'action-flow-running-long' : 'action-flow-running')
      }

      const actionGNode = actionG.node() as SVGGElement | null
      const iconBox = 16
      const canShowIcon = !isUserRequest
      if (actionGNode && canShowIcon) {
        appendActionFlowIcon(
          actionGNode,
          getActionFlowIconSvg(act.actionType),
          nx + w / 2,
          ny + h / 2,
          iconFill,
          `${reactId}-${layoutIndex}-`,
          iconBox,
        )
      }
      /** Duration mode: stamp readable duration inside wide blocks (> legacy 60 s badges) */
      if (durationMode && !isGhost && w >= 52 && act.durationMs > 0) {
        actionG
          .append('text')
          .attr('x', nx + 6)
          .attr('y', ny + 10)
          .attr('font-size', 9)
          .attr('font-weight', 600)
          .attr('fill', '#64748B')
          .attr('font-family', SVG_FONT_SANS)
          .text(formatDurationMs(act.durationMs))
          .attr('pointer-events', 'none')
      }

      /** Omit inline “⋯” menus per product decision */
    })

    /**
     * Explicit terminator wiring: each end node attaches to its rail’s eastern-most action (`x+w` maxima).
       *  - Vanilla: single main end anchored to farthest legacy action on the spine.
       *  - Fork compare:
       *      ghost/main end ← rightmost legacy action (including nested task tails);
       *      fork end ← rightmost forked action (nested tasks included).
       *    Decide membership with `forkCompareRow === 2`, not solely `actionSessionKey`, so forked-task tails stay connected.
       *  - Skip terminator pairs fan-in already handled (prevents doubling edges).
       */
      for (let endIdx = 0; endIdx < layout.length; endIdx++) {
      const endItem = layout[endIdx]!
      if (endItem.node.kind !== 'end') continue
      const endIsForkBranch = endItem.node.sessionRegion === 'fork-new-branch'
      let lastIdx = -1
      let lastRight = -Infinity
      for (let j = 0; j < layout.length; j++) {
        const it = layout[j]!
        if (it.node.kind !== 'action') continue
        const a = it.node as MappedAction & { row: number }
        const aIsNewBranch = isNewBranchAction(a)
        if (aIsNewBranch !== endIsForkBranch) continue
        const right = edgeAnchorRight(it)
        if (right > lastRight) {
          lastRight = right
          lastIdx = j
        }
      }
      if (lastIdx < 0) continue
      if (parallelJoinSkip.has(`${lastIdx}-${endIdx}`)) continue
      const lastItem = layout[lastIdx]!
      const lastAct = lastItem.node as MappedAction & { row: number }
      const isGhostEnd = !endIsForkBranch && hasForkNewBranchInLayout
      const stroke = isGhostEnd || lastAct.forkGhost ? FORK_GHOST_STROKE : actionFlowPalette.arrow
      const marker = isGhostEnd || lastAct.forkGhost ? ghostMarkerUrl : markerUrl
      appendOrthoEdgeBetweenItems(
        content,
        lastItem,
        endItem,
        marker,
        stroke,
        1.2,
        actionKey(lastAct),
        null,
      )
      }

      /**
       * Fork fan-out wiring: anchor fans into both rails’ first parent-scope actions —
       * - earliest ghost predecessor (post-fork leftover trail)
       * - earliest fork-branch parent action (`forkCompareRow === 2`)
       *
       * Ignore child-session internals so forks land on rails, not nested bands.
       */
      if (hasForkNewBranchInLayout && forkAnchorActionKey) {
      let anchorItem: (typeof layout)[number] | undefined
      for (const item of layout) {
        if (item.node.kind !== 'action') continue
        if (actionKey(item.node as MappedAction & { row: number }) === forkAnchorActionKey) {
          anchorItem = item
          break
        }
      }
      let firstGhostItem: (typeof layout)[number] | undefined
      let firstGhostSortTime = Infinity
      for (const item of layout) {
        if (item.node.kind !== 'action') continue
        const a = item.node as MappedAction & { row: number }
        if (a.forkGhost !== true) continue
        if (a.source === 'child-session') continue
        if (a.sortTime < firstGhostSortTime) {
          firstGhostSortTime = a.sortTime
          firstGhostItem = item
        }
      }
      let firstNewBranchItem: (typeof layout)[number] | undefined
      let firstNewBranchSortTime = Infinity
      for (const item of layout) {
        if (item.node.kind !== 'action') continue
        const a = item.node as MappedAction & { row: number }
        if (!isNewBranchAction(a)) continue
        if (a.source === 'child-session') continue
        if (a.sortTime < firstNewBranchSortTime) {
          firstNewBranchSortTime = a.sortTime
          firstNewBranchItem = item
        }
      }
      if (anchorItem) {
        const targets = [firstGhostItem, firstNewBranchItem].filter(
          (it): it is FlowLayoutItem => Boolean(it),
        )
        if (targets.length > 0) {
          appendOrthoFanOut(content, anchorItem, targets, markerUrl, ghostMarkerUrl)
        }
      }
      }

      /**
       * Safety net before the fork anchor: reconnect historical spine steps `1→2→…→anchor` when sequential layout misses hops.
       */
      if (hasForkNewBranchInLayout && forkAnchorActionKey) {
        let anchorSortTime = Infinity
        for (const item of layout) {
          if (item.node.kind !== 'action') continue
          const a = item.node as MappedAction & { row: number }
          if (actionKey(a) === forkAnchorActionKey) {
            anchorSortTime = a.sortTime
            break
          }
        }
        if (Number.isFinite(anchorSortTime)) {
          const prefixItems = layout
            .filter((item) => {
              if (item.node.kind !== 'action') return false
              const a = item.node as MappedAction & { row: number }
              if (a.source === 'child-session') return false
              if (isNewBranchAction(a)) return false
              if (a.forkGhost === true) return false
              return a.sortTime <= anchorSortTime
            })
            .sort((p, q) => {
              const pa = p.node as MappedAction & { row: number }
              const qa = q.node as MappedAction & { row: number }
              return pa.sortTime - qa.sortTime
            })
          for (let i = 0; i < prefixItems.length - 1; i++) {
            const from = prefixItems[i]!
            const to = prefixItems[i + 1]!
            const pa = from.node as MappedAction & { row: number }
            const pb = to.node as MappedAction & { row: number }
            if (parallelSiblingSkip(pa, pb)) continue
            const fromK = actionKey(pa)
            const toK = actionKey(pb)
            if (edgeExists(fromK, toK)) continue
            const { stroke, markerUrl: m } = edgeStrokeAndMarker(pa, pb, markerUrl, ghostMarkerUrl)
            appendOrthoEdgeBetweenItems(content, from, to, m, stroke, 1.2, fromK, toK)
          }
        }
      }

      /** Purple branch from parent Subagent(task) rects into nested child-session entry */
      for (let i = 0; i < layout.length - 1; i++) {
      const item = layout[i]!
      const node = item.node
      if (node.kind !== 'action') continue
      if (node.actionType !== 'Subagent' || !node.childSessionID || !node.callID) continue
      let firstChild: (typeof layout)[0] | undefined
      for (let j = i + 1; j < layout.length - 1; j++) {
        const it = layout[j]!
        if (it.node.kind !== 'action') continue
        const a = it.node as MappedAction & { row: number }
        if (
          a.source === 'child-session' &&
          a.parentTaskCallID === node.callID &&
          a.branchChildSessionID === node.childSessionID
        ) {
          firstChild = it
          break
        }
      }
      if (!firstChild) continue
      const parentAct = node as MappedAction & { row: number }
      const childAct = firstChild.node as MappedAction & { row: number }
      const { stroke: branchStroke, markerUrl: branchMarker } = edgeStrokeAndMarker(
        parentAct,
        childAct,
        markerUrl,
        ghostMarkerUrl
      )
      const branchPathD = orthoEdgePathD(
        edgeAnchorRight(item),
        item.cy,
        edgeAnchorLeft(firstChild),
        firstChild.cy,
      )
      content
        .append('path')
        .attr('class', 'afv-edge')
        .attr('d', branchPathD)
        .attr('fill', 'none')
        .attr('stroke', branchStroke)
        .attr('stroke-width', 1.2)
        .attr('marker-end', branchMarker)
        .attr('pointer-events', 'none')
      }

      if (canMockFork) {
        const forkItem = layout[mockBranchForkActionIndex as number]
        if (forkItem) {
        const historyTemplates = [
          { actionType: 'Think', status: 'completed', durationMs: 420, tokenEstimate: 24 },
          { actionType: 'Read', status: 'completed', durationMs: 560, tokenEstimate: 40 },
          { actionType: 'Response', status: 'completed', durationMs: 380, tokenEstimate: 28 },
        ] as const
        const historyY = rowTopY(0) - ROW_H + BLOCK_H / 2

        const historyWidths = historyTemplates.map(h => blockWidth(durationMode, h.durationMs))
        const historyStartX = forkItem.x + forkItem.w + GAP

        let hx = historyStartX
        historyTemplates.forEach((h, i) => {
          const hw = historyWidths[i]!
          content
            .append('rect')
            .attr('x', hx)
            .attr('y', historyY - BLOCK_H / 2)
            .attr('width', hw)
            .attr('height', BLOCK_H)
            .attr('rx', 4)
            .attr('fill', '#ECECEC')
            .attr('stroke', '#CFCFCF')
            .attr('stroke-width', 1.5)
            .style('cursor', 'default')

          if (contentNode) {
            appendActionFlowIcon(
              contentNode,
              getActionFlowIconSvg(h.actionType),
              hx + hw / 2,
              historyY,
              '#B5B5B5',
              `${reactId}-mock-history-${i}-`
            )
          }

          if (i < historyTemplates.length - 1) {
            const link = d3.path()
            link.moveTo(hx + hw, historyY)
            link.lineTo(hx + hw + GAP, historyY)
            content
              .append('path')
              .attr('d', link.toString())
              .attr('fill', 'none')
              .attr('stroke', '#C8C8C8')
              .attr('stroke-width', 1.2)
              .attr('marker-end', markerUrl)
              .attr('pointer-events', 'none')
          }
          hx += hw + GAP
        })

        const firstHistoryX = historyStartX
        // Match primary edges: orthogonal H-V-H pivot at midpoint to avoid diagonal segments
        const x1 = forkItem.x + forkItem.w
        const y1 = forkItem.cy
        const x2 = firstHistoryX
        const y2 = historyY
        const mid = (x1 + x2) / 2
        const connect = d3.path()
        connect.moveTo(x1, y1)
        connect.lineTo(mid, y1)
        connect.lineTo(mid, y2)
        connect.lineTo(x2, y2)
        content
          .append('path')
          .attr('d', connect.toString())
          .attr('fill', 'none')
          .attr('stroke', '#C8C8C8')
          .attr('stroke-width', 1.2)
          .attr('marker-end', markerUrl)
          .attr('pointer-events', 'none')
        }
      }

    /** Rectangles paint after edges by default — re-raise paths so strokes stay readable */
    content.selectAll<SVGPathElement, unknown>('path.afv-edge').raise()

    const desiredH = totalH + topOffset
    // Pixel-sized SVG (no scaling viewBox) keeps block proportions stable regardless of lane count
    root.attr('width', totalW).attr('height', desiredH)
    svg.removeAttribute('viewBox')

    if (filterMode !== null && autoScrollFirstFilteredMatch) {
      const firstMatched = layout.find((item) => {
        if (item.node.kind !== 'action') return false
        const a = item.node as MappedAction & { row: number }
        if (filterMode === 'duration') {
          return Number.isFinite(a.durationMs) && a.durationMs >= (durationHighlightMinMs as number)
        }
        return Number.isFinite(a.tokenEstimate) && a.tokenEstimate >= (tokenHighlightMin as number)
      })
      if (firstMatched && scrollRef.current) {
        const targetLeft = Math.max(0, firstMatched.x - 18)
        scrollRef.current.scrollTo({ left: targetLeft, behavior: 'smooth' })
      }
    }
  }, [
    actions,
    durationMode,
    colorMode,
    actionTypePaletteId,
    durationHighlightMinMs,
    tokenHighlightMin,
    autoScrollFirstFilteredMatch,
    tooltipMessages,
    markerId,
    tooltipId,
    mockBranchForkActionIndex,
    onForkFromAction,
    onAnalyzeFromAction,
    showFlowEndNode,
    flowEndSummary,
    embedded,
    viewportMaxHeight,
    forkAnchorActionKey,
  ])

  /**
   * Unified dimming pipeline merges cross-subtask `dimAll`, type-level highlighting, thresholds, and edges.
   * - `dimAll`: fade entire visualization while another card holds focus.
   * - **`highlightedActionKey`**: keep peers at full-opacity (no perimeter stroke — selection is conveyed by connectors only).
   * - **`highlightedActionType`** (no key): fades groups outside the matching type bucket.
   * - Threshold mode tags `data-filter-dim` on groups / edges independently.
   */
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const groups = Array.from(svg.querySelectorAll<SVGGElement>('g.afv-action[data-action-key]'))
    const edges = Array.from(svg.querySelectorAll<SVGPathElement>('path.afv-edge'))
    const DIM = '0.18'
    const durationFilterActive =
      durationHighlightMinMs != null && Number.isFinite(durationHighlightMinMs)
    const tokenFilterActive =
      tokenHighlightMin != null && Number.isFinite(tokenHighlightMin)
    const thresholdFilterActive = durationFilterActive || tokenFilterActive

    if (dimAll) {
      svg.style.opacity = '0.35'
    } else {
      svg.style.opacity = ''
    }

    /** Highlight bucket: singleton key vs every key sharing the hovered type */
    let highlightSet: Set<string> | null = null
    if (highlightedActionKey) {
      highlightSet = new Set([highlightedActionKey])
    } else if (highlightedActionType) {
      highlightSet = new Set()
      for (const g of groups) {
        if (g.getAttribute('data-action-type') === highlightedActionType) {
          const k = g.getAttribute('data-action-key')
          if (k) highlightSet.add(k)
        }
      }
    }

    if (highlightSet === null && !thresholdFilterActive) {
      for (const g of groups) g.style.opacity = '1'
      for (const e of edges) e.style.opacity = '1'
      return
    }

    /** Single-action click: emphasize with a stroke ring only — do not fade other glyphs. */
    const outlineOnlySingleAction = Boolean(highlightedActionKey)

    for (const g of groups) {
      const k = g.getAttribute('data-action-key') ?? ''
      const filterDimActive =
        highlightSet === null &&
        thresholdFilterActive &&
        g.getAttribute('data-filter-dim') === '1'
      const selDim =
        outlineOnlySingleAction
          ? false
          : highlightSet !== null && !highlightSet.has(k)
      g.style.opacity = (selDim || filterDimActive) ? DIM : '1'
    }

    for (const e of edges) {
      const fk = e.getAttribute('data-from-key')
      const tk = e.getAttribute('data-to-key')
      let dim = false
      if (highlightSet !== null && !outlineOnlySingleAction) {
        const fromHit = fk !== null && highlightSet.has(fk)
        const toHit = tk !== null && highlightSet.has(tk)
        dim = !fromHit && !toHit
      }
      /** Edges inherit threshold dimming when both endpoints fail the filter */
      if (!dim && highlightSet === null && thresholdFilterActive && (fk || tk)) {
        const esc = (s: string) =>
          typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"')
        const fromGroup = fk ? svg.querySelector<SVGGElement>(`g.afv-action[data-action-key="${esc(fk)}"]`) : null
        const toGroup = tk ? svg.querySelector<SVGGElement>(`g.afv-action[data-action-key="${esc(tk)}"]`) : null
        const fromFiltered = fromGroup?.getAttribute('data-filter-dim') === '1'
        const toFiltered = toGroup?.getAttribute('data-filter-dim') === '1'
        if (fromFiltered && toFiltered) dim = true
      }
      e.style.opacity = dim ? DIM : '1'
    }
  }, [highlightedActionType, highlightedActionKey, dimAll, actions, durationHighlightMinMs, tokenHighlightMin])

  const mockOffset = mockBranchForkActionIndex !== undefined ? ROW_H : 0
  const contentHeight = layoutEstimate.totalH + mockOffset
  /** Scroll port enforces a two-lane minimum height; height grows with content (no MAX_VISIBLE_ROWS cap) */
  const minContentHeight = MIN_SVG_CONTENT_HEIGHT
  const normalViewportHeight = Math.max(contentHeight, minContentHeight)
  let viewportHeight = normalViewportHeight
  if (typeof viewportMaxHeight === 'number' && Number.isFinite(viewportMaxHeight) && viewportMaxHeight > 0) {
    viewportHeight = Math.min(viewportHeight, viewportMaxHeight)
  }
  /** `maxHeight` caps overflow only — short content keeps intrinsic height (no phantom scrollbars) */
  const scrollAreaMaxHeight = viewportHeight

  /** Avoid inner borders — `box-sizing` would shrink scrollable area vs SVG by 2 px and falsely show scrollbars */
  const scrollInner = (
    <div
      className={hideScrollbar ? 'action-flow-scroll--hide-scrollbar' : undefined}
      onClick={() => onSelectAction?.(null)}
      style={{
        boxSizing: 'border-box',
        overflowX: 'auto',
        overflowY: 'auto',
        width: '100%',
        flexShrink: 0,
        height: 'auto',
        maxHeight: scrollAreaMaxHeight,
        minHeight: 0,
      }}
      ref={scrollRef}
    >
      <svg
        ref={svgRef}
        data-action-flow-root="1"
        style={{
          display: 'block',
          verticalAlign: 'top',
        }}
      />
    </div>
  )

  return (
    <>
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        flexShrink: 0,
        alignSelf: 'flex-start',
        width: '100%',
      }}
    >
      {embedded ? (
        scrollInner
      ) : (
        <div
          style={{
            boxSizing: 'border-box',
            border: '1px solid #E8E8E8',
            borderRadius: 8,
            background: '#FCFCFC',
            overflow: 'hidden',
            width: '100%',
          }}
        >
          {scrollInner}
        </div>
      )}
      {tooltipMounted && (
        <Tooltip
          id={tooltipId}
          anchorSelect={`[data-tooltip-id="${tooltipId}"]`}
          className="action-flow-react-tooltip"
          variant="light"
          positionStrategy="fixed"
          delayShow={150}
          delayHide={220}
          opacity={1}
          clickable
          /** Inner `overflow:auto` can bubble `scroll` globally and dismiss tooltips prematurely */
          globalCloseEvents={{ scroll: false, resize: true, escape: true }}
          arrowColor="#f8fafc"
        />
      )}
    </div>
    <ActionFlowContextMenu
      menu={contextMenu}
      onClose={() => setContextMenu(null)}
      onFork={onForkFromAction}
      onAnalysis={onAnalyzeFromAction}
    />
    </>
  )
}
