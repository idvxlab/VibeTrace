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
import { effectiveStatusColors, resolveActionBlockColors } from '../utils/actionFlowColors'
import { appendActionFlowIcon, getActionFlowIconSvg } from './actionFlowIcons'
import ActionFlowContextMenu, { type ActionFlowContextMenuState } from './ActionFlowContextMenu'
import { actionKey } from '../utils/actionKey'

type FlowNode =
  | { kind: 'end'; row: number; sessionRegion: 'main' | 'fork-new-branch' }
  | (MappedAction & { row: number; kind: 'action' })

/** `computeLayout` 输出的每一项，用于连线 bundling */
type FlowLayoutItem = {
  node: FlowNode
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
}

type FlowLayoutMode = 'timeline' | 'packing'

const MARGIN_LEFT = 24
const PACKING_MARGIN_LEFT = 8
const PACKING_MARGIN_RIGHT = 8
const GAP = 12
/**
 * 垂直布局（与 `actionMapping` 一致）：
 * - 每个 session 块内 2 个基础 layer：layer0 = kernel（Think/Response/Plan…），layer1 = 工具等；
 * - 父侧 task（Subagent）：一旦解析出 `childSessionID`，整块 rect 归入 **`session:task:` 子会话区域**（不再出现在主 session 内）；
 * - 同一 layer 上并行动作用 parallelLaneIndex 再向下错开，故「行数」随并行度增高；
 * - 子会话块在 main 下方，内部同样 layer + lane，高度亦非定值。
 */
const BLOCK_H = 28
const ROW_H = 32
/** 同一 row 上并行 lane 的垂直错开（与主 row 间距一致） */
const PARALLEL_LANE_DY = ROW_H
const SESSION_REGION_GAP = 10
const TOP_PAD = 4
const MIN_W = 28
/** Duration mode: 小于等于该时长统一用最小宽度（单位 ms） */
const DUR_WIDTH_BASE_MS = 10
/** Duration mode: 与 `DUR_BLOCK_AT_REF_PX` 成对的参考 wall-clock 时长 */
const DUR_REF_MS = 120_000
/** Duration mode: `DUR_REF_MS` 处 block 的右边界（`<=DUR_WIDTH_BASE_MS` 仍用 `MIN_W`） */
const DUR_BLOCK_AT_REF_PX = 200
const DUR_BETA_MS = Math.max(1, DUR_REF_MS - DUR_WIDTH_BASE_MS)
/**
 * Block 宽（action rect）：`w = MIN_W + DUR_PX_PER_MS * (durationMs - 10)`，故 10ms 以下 28px、120s 时 200px，之后线性延伸。
 * 与「两 slot 间空档」比例独立，见 `DUR_GAP_MIN_PX` / `DUR_GAP_REF_PX`。
 */
const DUR_PX_PER_MS = (DUR_BLOCK_AT_REF_PX - MIN_W) / DUR_BETA_MS
/**
 * 空档（idle）水平像素：最小 `DUR_GAP_MIN_PX`，在 `DUR_GAP_REF_MS` 时总宽 `DUR_GAP_REF_PX`（与 10ms 基线同斜率公式的“间隔版”）：
 * `gapPx = DUR_GAP_MIN_PX + DUR_GAP_PX_PER_MS * max(0, gapMs - 10)`.
 * 改比例：动 `DUR_GAP_MIN_PX` / `DUR_GAP_REF_PX` / `DUR_GAP_REF_MS`（及可选 `DUR_WIDTH_BASE_MS` 共用于 block+gap 时间基线）。
 */
const DUR_GAP_MIN_PX = 10
const DUR_GAP_REF_PX = 200
/** 与 `DUR_GAP_MIN_PX` / `DUR_GAP_REF_PX` 成对；可与 `DUR_REF_MS`（block）不同，独立改“间隔的参考时间”时改此值 */
const DUR_GAP_REF_MS = DUR_REF_MS
const DUR_GAP_BETA_MS = Math.max(1, DUR_GAP_REF_MS - DUR_WIDTH_BASE_MS)
const DUR_GAP_PX_PER_MS = (DUR_GAP_REF_PX - DUR_GAP_MIN_PX) / DUR_GAP_BETA_MS
const DUR_TAIL_PAD_PX = 2
const BOTTOM_PAD = 6
/** 至少两行泳道 + 两块 action 时的最小画布高度，避免空数据时 SVG 塌成几十像素 */
const MIN_SVG_CONTENT_HEIGHT = TOP_PAD + 2 * ROW_H + 2 * BLOCK_H + BOTTOM_PAD
/** 视口上限：约 4 行（含上下 padding） */
const MAX_VISIBLE_ROWS = 4
/** 与右键菜单一致，用于 ⋯ 等 SVG 文字 */
const SVG_FONT_SANS =
  "'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"
/** 分叉快照中「已不在上下文」的幽灵段：rect / 连线 */
const FORK_GHOST_STROKE = '#B8B8B8'
const FORK_GHOST_MARKER_FILL = '#B8B8B8'

/**
 * 与 block 同一条斜率线：`[10ms,120s] → [28px,200px]` 之外继续线性延伸、无上封顶。
 * `w = 28 + DUR_PX_PER_MS * (duration - 10)` 当 duration > 10。
 */
function durationBlockExtraPx(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= DUR_WIDTH_BASE_MS) return 0
  return DUR_PX_PER_MS * (durationMs - DUR_WIDTH_BASE_MS)
}

/**
 * 相邻两 slot 空档 `gapMs = next.minStart - prev.maxEnd`（已 clamp ≥0）→ 布局上 `interSlotGap` 像素，近似等于正交边水平段长度。
 * 与 block 的 `MIN_W=28` 不同：空档从 `DUR_GAP_MIN_PX=10` 起算，2min 时总宽 200px。
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
 * 会话垂直分区（顺序很重要）：
 * 1. `session:task:<parentTaskCallID>`：child-session 动作 / 已解析出 childSessionID 的父 Subagent
 *    都进入对应的子会话区域。**fork 前后规则一致** —— 新分支里的 task 也照样进自己的子会话区。
 * 2. `session:fork-new-branch`：fork 后新会话「主泳道」上的非 task 动作（kernel / 工具等），
 *    `forkCompareRow === 2` 标记。x 从 fork 锚点右缘起算独立推进，y 放在历史区域之下。
 * 3. `session:main`：fork 之前 / 普通模式下主进程会话内的非 task 动作。
 *
 * 注意：判别顺序必须先 child-session / Subagent→childSession，再 forkCompareRow，
 * 否则新分支里的 task 会被强行塞进 fork-new-branch、与它的子会话割裂。
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

/** 是否属于「fork 之后的新分支」(包括新分支里的 task / 子 session)。统一以 forkCompareRow=2 标记 */
function isNewBranchAction(a: MappedAction & { row: number }): boolean {
  return a.forkCompareRow === 2
}

/** 父 task 在数据里仍是 layer1；在子会话 **区域** 内绘制时固定为第一行（新开 session 的顶轨） */
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

/** 把「当前用到的行」在固定总高 totalH 内竖直居中（整体 translate 到 content <g>） */
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
    layoutMode?: FlowLayoutMode
    packingFitWidthPx?: number | null
  }
) {
  const layoutMode = layoutOpts?.layoutMode ?? 'timeline'
  if (layoutMode === 'packing') {
    return computePackingLayout(actions, durationMode, {
      forkAnchorActionKey: layoutOpts?.forkAnchorActionKey ?? null,
      fitWidthPx: layoutOpts?.packingFitWidthPx ?? null,
    })
  }
  const includeEndNode = layoutOpts?.includeEndNode !== false
  const forkAnchorActionKey = layoutOpts?.forkAnchorActionKey ?? null
  const sorted = [...actions].sort((a, b) => a.sortTime - b.sortTime)

  /** step 间距收紧：顺序推进时不拉太开 */
  const TIMELINE_STEP_GAP = 10

  const sessionKeySet = new Set<string>()
  sorted.forEach((a) => sessionKeySet.add(actionSessionKey(a)))

  /**
   * 「是否在 fork 对比模式」：只要存在任意 forkCompareRow=2 的 action 就成立 —— 包含
   * 新分支只有 task / 子 session 没有「主泳道」非 task 动作的边角情况。
   * `hasForkNewBranchSession` 仅判断 `session:fork-new-branch` 区域是否存在（决定要不要单独占一条泳道）。
   */
  const hasNewBranchAction = sorted.some(isNewBranchAction)
  const hasForkNewBranchSession = sessionKeySet.has('session:fork-new-branch')

  /** task 子会话区域 → 是否属于「新分支的 task」（看父 Subagent 的 forkCompareRow） */
  const isNewBranchTaskKey = (k: string): boolean => {
    if (!k.startsWith('session:task:')) return false
    const callID = k.slice('session:task:'.length)
    const parent = sorted.find(
      (a) => a.actionType === 'Subagent' && a.source !== 'child-session' && a.callID === callID,
    )
    if (parent) return parent.forkCompareRow === 2
    /** 兜底：父 Subagent 不在当前数据中（理论上不会，安全起见看本区域里的 child-session 动作标记） */
    const anyAction = sorted.find((a) => actionSessionKey(a) === k)
    return anyAction?.forkCompareRow === 2
  }

  const sessionOrder: string[] = []
  if (sessionKeySet.has('session:main')) sessionOrder.push('session:main')

  /**
   * Fork 对比模式下两条平行支线，每条独立终点：
   *  - 历史轨迹（含锚点 + 灰幽灵）→ 灰色 end（嵌在主泳道右端）
   *  - 新分支 → 正常 end（嵌在新泳道右端）
   * 普通模式仍然只有一个 main end。
   * end 节点必须能识别属于哪条支线（sessionRegion），否则 x/y 都对不上。
   */
  const seq: FlowNode[] = sorted.map(a => ({ ...a, kind: 'action' as const }))
  if (includeEndNode) {
    seq.push({ kind: 'end', row: 1, sessionRegion: 'main' })
    if (hasNewBranchAction) {
      seq.push({ kind: 'end', row: 1, sessionRegion: 'fork-new-branch' })
    }
  }
  const childKeys = [...sessionKeySet].filter(
    (k) => k !== 'session:main' && k !== 'session:fork-new-branch'
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
   * Fork 后泳道顺序：
   *   main (历史含 anchor + ghost)
   *   → 历史 task 子会话区 (parent 为历史 Subagent)
   *   → session:fork-new-branch (新分支「主泳道」非 task 动作)
   *   → 新分支 task 子会话区 (parent 为新分支 Subagent)
   * 这样新分支的子 session 不会被挤到历史泳道之间，整段「新分支」在视觉上聚团在底部。
   */
  const historicalChildKeys = sortChildKeys(childKeys.filter((k) => !isNewBranchTaskKey(k)))
  const newBranchChildKeys = sortChildKeys(childKeys.filter((k) => isNewBranchTaskKey(k)))
  sessionOrder.push(...historicalChildKeys)
  if (hasForkNewBranchSession) sessionOrder.push('session:fork-new-branch')
  sessionOrder.push(...newBranchChildKeys)
  if (sessionOrder.length === 0) sessionOrder.push('session:main')

  /** 全局画布上的 x（索引 -> x） */
  const actionXBySortedIndex = new Map<number, number>()

  /**
   * 根轴：所有「非新分支 + 非 child-session」的动作（即历史轨迹的父侧）。
   * 新分支 (forkCompareRow=2) 的父侧动作 —— 包括新分支 Subagent —— 一律走 branch 局部 x 轨，
   * 不与历史动作竞争横轴位置。
   */
  const rootIndices = sorted
    .map((a, idx) => ({ a, idx }))
    .filter((x) => x.a.source !== 'child-session' && !isNewBranchAction(x.a))
    .map((x) => x.idx)

  /** 根轴 slot（统一时间轴） */
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
      const session = actionSessionKey(a)
      const isParentTaskEntry = a.actionType === 'Subagent' && a.source !== 'child-session' && Boolean(a.callID)
      const groupKey = isParentTaskEntry ? a.parallelGroupId : `${session}::${a.parallelGroupId}`
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
   * 子 session 局部轴（相对偏移）：
   * - 每个子 session 仅按自身动作推进；
   * - 记录 childSpan，用于扩展父 task 所在 slot 的有效右边界。
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
    /** Duration mode: 记录每个 child slot 的时间区间，用于计算相邻 slot 之间的 idle gap */
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

  /** 根轴每个 slot 的有效跨度：max(父块宽, 父task->子session全程宽) */
  const rootSlotEffectiveSpan = new Map<string, number>()
  const rootSlotOffsetByIndex = new Map<number, number>()
  /** Duration mode: 记录每个 root slot 的时间区间，用于计算相邻 slot 间的 idle gap */
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
   * Fork 新分支：作为根轴上 anchor 右缘 + gap 起算的独立 x 轨。
   * 必须先算完 branch x，子 session 的 x 才能对齐到「新分支 Subagent 的右缘」。
   * - 与 anchor 之后的「灰色幽灵后缀」共享相同的起点 x，但在不同 session 区域（垂直分开），
   *   形成「同一 SVG 内的两条平行支线」视觉效果。
   * - 若没有显式 anchor 或没有任何幽灵动作，回退到主轴右端起算。
   */
  let forkBranchRight = MARGIN_LEFT
  if (hasNewBranchAction) {
    /** 1. 解析 anchor 在主轴上的右缘（anchor 必定是历史动作，已有 root 轴 x） */
    let anchorRight: number | null = null
    if (forkAnchorActionKey) {
      for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i]!
        if (actionKey(a) === forkAnchorActionKey) {
          const x = actionXBySortedIndex.get(i)
          if (x != null) {
            const w = blockWidth(durationMode, a.durationMs)
            anchorRight = x + w
            /** anchor 自己若是带 child session 的 Subagent，下沉支线必须越过 child 区域，
             *  否则 ghost / 新分支会与 anchor 的子 session 横向叠合。 */
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
      /** 兜底：取主轴最右「非新分支」动作的右缘（连同其子 session 末端） */
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
     * 2. branch indices = 所有「forkCompareRow=2 且非 child-session」的动作。
     *    包含新分支的 Subagent —— 它们虽然 actionSessionKey 落在 task 子区域（与 fork 前一致），
     *    但 x 必须走 branch 轨而非 root 轨，否则会和历史动作抢占同一段水平空间。
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
    /** branch slot 有效宽度需考虑「新分支 Subagent 的子 session 宽度」，否则下一个 branch slot
     *  会与子 session 横向重叠（与 root 轨同样的逻辑）。 */
    const branchSlotEffectiveSpan = new Map<string, number>()
    /** Duration mode: 记录每个 branch slot 的时间区间 */
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
     * 双轨对齐：ghost 走的根轴 slot 与新分支走的 branch slot 是两套独立累计的 cursor，
     * 即便 TIMELINE_STEP_GAP 相同，只要每个 slot 自己的 effectiveSpan 不同（duration 不一致 /
     * Subagent 子 session 宽度不同），ghost 第 k 步与新分支第 k 步的 x 就会错开。
     *
     * 这里做一次「post-anchor 对齐」：把 ghost root slot 和 branch slot 按出现顺序成对，
     * 第 k 步统一宽度 = max(ghostSpan_k, branchSpan_k)，从 forkBaseX 开始用统一宽度推进，
     * 同步重写两边的 actionXBySortedIndex。后续 child session 绝对 x 在更下方一轮按 parent x
     * 重新计算，会自动跟随。
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
   * 子 session 绝对 x = 父 task 右缘 + gap + 本地相对 x。
   * **必须放在 branch x 计算之后** —— 新分支的 task 父节点 x 在 branch 轨里设置，
   * 否则 `actionXBySortedIndex.get(parentIdx)` 拿到的是 undefined / fallback。
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

  /**
   * 两条支线各自的 end x：
   *  - main：根轴游标（rootCursor 已是最右 root slot 右缘 + TIMELINE_STEP_GAP）。
   *    需要进一步拉到「所有非新分支动作」的实际最右（包括历史子 session 末端）以避免线条穿过子 session。
   *  - fork-new-branch：分支右缘 + 一段 gap（forkBranchRight 已包含新分支 Subagent 的子 session 宽度）。
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
      /** 区域内 y 仅由 row（kernel/tool）+ 并行 lane 决定；fork 区分已经体现为
       *  「独立 session 区域 + sessionTopY」，不再额外加 FORK_COMPARE_ROW_GAP，
       *  否则新分支会被多顶 88px，与历史轨迹中间出现一片空地。 */
      const yInSession =
        actionLocalRowForLayout(a) * ROW_H + laneOffsetY(a.parallelLaneIndex)
      maxBottom = Math.max(maxBottom, yInSession + BLOCK_H)
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
       * 每条支线 end 各占自己泳道的第一行：
       *  - sessionRegion='main' → 历史轨迹的 end（普通模式 / 历史灰端）
       *  - sessionRegion='fork-new-branch' → 新分支的 end
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
      /** 与 sessionTopY 同步：y 不再加 forkCompareRow * FORK_COMPARE_ROW_GAP */
      const y = yBase + actionLocalRowForLayout(a) * ROW_H + laneOffsetY(a.parallelLaneIndex)
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

/**
 * Packing 布局的 session 分组键。
 * - 父侧 Subagent task 条目（source !== 'child-session'）归入对应子 session 行（作为该行首块）
 * - 子 session 内部 action 归入同一行
 * - fork 新分支单独一行
 * - 其余归 session:main
 */
function packingSessionKey(a: MappedAction & { row: number }): string {
  if (a.actionType === 'Subagent' && a.source !== 'child-session' && a.callID) {
    return `session:task:${a.callID}`
  }
  if (a.source === 'child-session' && a.parentTaskCallID) {
    return `session:task:${a.parentTaskCallID}`
  }
  if (a.forkCompareRow === 2) {
    return 'session:fork-new-branch'
  }
  return 'session:main'
}

function computePackingLayout(
  actions: (MappedAction & { row: number })[],
  durationMode: boolean,
  opts?: { forkAnchorActionKey?: string | null; fitWidthPx?: number | null }
) {
  const { forkAnchorActionKey = null, fitWidthPx = null } = opts ?? {}
  const marginLeft = PACKING_MARGIN_LEFT
  const marginRight = PACKING_MARGIN_RIGHT
  const sorted = [...actions].sort((a, b) => a.sortTime - b.sortTime)
  const rowPitch = BLOCK_H

  if (sorted.length === 0) {
    return { layout: [] as FlowLayoutItem[], totalW: 360, totalH: TOP_PAD + rowPitch + BOTTOM_PAD }
  }

  /** Subagent task 入口固定用 MIN_W（紧凑前缀，不编码实际时长） */
  const widthOf = (a: MappedAction & { row: number }): number =>
    a.actionType === 'Subagent' && a.source !== 'child-session' && Boolean(a.callID)
      ? MIN_W
      : blockWidth(durationMode, a.durationMs)

  // --- 按 session 分组（新 key：Subagent → 子 session） ---
  const sessionActions = new Map<string, (MappedAction & { row: number })[]>()
  for (const a of sorted) {
    const key = packingSessionKey(a)
    let list = sessionActions.get(key)
    if (!list) { list = []; sessionActions.set(key, list) }
    list.push(a)
  }

  // --- session 行顺序：main → 子 sessions（按触发时间）→ fork ---
  const childSessionKeys = [...sessionActions.keys()]
    .filter(s => s !== 'session:main' && s !== 'session:fork-new-branch')
    .sort((a, b) => {
      const ta = sessionActions.get(a)![0]!.sortTime
      const tb = sessionActions.get(b)![0]!.sortTime
      return ta !== tb ? ta - tb : a.localeCompare(b)
    })
  const sessionOrder: string[] = []
  if (sessionActions.has('session:main')) sessionOrder.push('session:main')
  sessionOrder.push(...childSessionKeys)
  if (sessionActions.has('session:fork-new-branch')) sessionOrder.push('session:fork-new-branch')
  if (sessionOrder.length === 0) sessionOrder.push('session:main')

  // --- 预计算各子 session 的总宽度（各自独立游标，并行 session 互不影响） ---
  const childSessionTotalW = new Map<string, number>()
  for (const key of childSessionKeys) {
    const acts = sessionActions.get(key)!
    childSessionTotalW.set(key, acts.reduce((s, a) => s + widthOf(a), 0))
  }

  // --- x 轴布局：主 session 游标 + 子 session 触发预留空间 ---
  //
  // 主时间轴事件 = 主 session action + Subagent 触发事件（按 sortTime 混合排序）。
  // 遇到 Subagent 触发：
  //   · 并行触发（相同 parallelGroupId）共享同一 x 起点，主游标推进 max(并行宽度)。
  //   · 串行触发各自推进。
  // 遇到主 session action：直接放置，推进游标。
  const subagentEvents = sorted.filter(
    a => a.actionType === 'Subagent' && a.source !== 'child-session' && Boolean(a.callID)
  )
  const mainTimeline = [
    ...(sessionActions.get('session:main') ?? []),
    ...subagentEvents,
  ].sort((a, b) => a.sortTime - b.sortTime)

  const actionX = new Map<MappedAction & { row: number }, number>()
  const childSessionStartX = new Map<string, number>()
  const processedParallelGroups = new Set<string>()
  let mainCursor = marginLeft

  for (const event of mainTimeline) {
    if (event.actionType === 'Subagent' && event.source !== 'child-session' && event.callID) {
      // 找出所有并行兄弟（相同 parallelGroupId），整组共享同一 x 起点
      const gid = event.parallelGroupId
      if (gid && processedParallelGroups.has(gid)) continue  // 已作为并行组的一部分处理过

      const siblings = gid
        ? subagentEvents.filter(a => a.parallelGroupId === gid)
        : [event]
      if (gid) processedParallelGroups.add(gid)

      const startX = mainCursor
      let maxChildW = 0
      for (const sub of siblings) {
        const childKey = `session:task:${sub.callID!}`
        childSessionStartX.set(childKey, startX)
        maxChildW = Math.max(maxChildW, childSessionTotalW.get(childKey) ?? MIN_W)
      }
      // 主游标越过最宽的并行子 session（并行 session 各自占用该 x 区间但互不干扰）
      mainCursor += maxChildW
    } else {
      actionX.set(event, mainCursor)
      mainCursor += widthOf(event)
    }
  }

  let maxRight = mainCursor

  // --- 各子 session 独立游标，从各自 startX 出发 ---
  for (const key of childSessionKeys) {
    const acts = sessionActions.get(key)!
    let cursor = childSessionStartX.get(key) ?? mainCursor
    for (const a of acts) {
      actionX.set(a, cursor)
      cursor += widthOf(a)
    }
    maxRight = Math.max(maxRight, cursor)
  }

  // --- fork 新分支（从 forkAnchorActionKey 右侧起，或主游标末端）---
  const forkActs = sessionActions.get('session:fork-new-branch') ?? []
  if (forkActs.length > 0) {
    let forkStart = mainCursor
    if (forkAnchorActionKey) {
      for (const [a, x] of actionX) {
        if (actionKey(a) === forkAnchorActionKey) {
          forkStart = x + widthOf(a)
          break
        }
      }
    }
    let cursor = forkStart
    for (const a of forkActs) {
      actionX.set(a, cursor)
      cursor += widthOf(a)
    }
    maxRight = Math.max(maxRight, cursor)
  }

  // --- y 位置（固定行高，按 session 行顺序） ---
  const sessionTopY = new Map<string, number>()
  for (let i = 0; i < sessionOrder.length; i++) {
    sessionTopY.set(sessionOrder[i]!, TOP_PAD + i * rowPitch)
  }

  // --- 生成 layout 条目 ---
  const layout: FlowLayoutItem[] = []
  for (const [key, acts] of sessionActions) {
    const y = sessionTopY.get(key) ?? TOP_PAD
    for (const a of acts) {
      const x = actionX.get(a) ?? marginLeft
      const w = widthOf(a)
      const h = BLOCK_H
      layout.push({ node: { ...a, kind: 'action' as const }, x, y, w, h, cx: x + w / 2, cy: y + h / 2 })
    }
  }

  // --- fit-to-width 缩放（只压 x/w，行高保持固定） ---
  let totalW = Math.max(maxRight + marginRight, 220)
  if (fitWidthPx != null && Number.isFinite(fitWidthPx) && fitWidthPx > 0) {
    const targetTotalW = Math.max(220, fitWidthPx)
    const naturalSpan = Math.max(1, maxRight - marginLeft)
    const availableSpan = Math.max(1, targetTotalW - marginLeft - marginRight)
    const scale = Math.min(1, availableSpan / naturalSpan)
    if (scale < 1) {
      for (const item of layout) {
        item.x = marginLeft + (item.x - marginLeft) * scale
        item.w = Math.max(2, item.w * scale)
        item.cx = item.x + item.w / 2
      }
      totalW = targetTotalW
    } else {
      totalW = Math.min(totalW, targetTotalW)
    }
  }

  const maxBottom = layout.reduce((m, it) => Math.max(m, it.y + it.h), TOP_PAD)
  const totalH = Math.max(maxBottom + BOTTOM_PAD, TOP_PAD + rowPitch + BOTTOM_PAD)
  return { layout, totalW, totalH }
}

function parallelSiblingSkip(pa: MappedAction, pb: MappedAction): boolean {
  if (!pa.parallelGroupId || !pb.parallelGroupId) return false
  if (pa.parallelGroupId !== pb.parallelGroupId) return false
  if (pa.parallelLaneIndex === undefined || pb.parallelLaneIndex === undefined) return false
  return pa.parallelLaneIndex !== pb.parallelLaneIndex
}

/**
 * 一个前驱扇出到多个并行后继：所有 targets 共用同一 bundleX 作为「分叉竖轴」，
 * 从而所有支线的竖直段都在同一 x 位置，不产生交叉。
 * - Trunk（pred.right → bundleX，水平）：画一次，不带箭头
 * - Branches（bundleX → target.cy（竖直）→ target.x（水平）+ 箭头）：每个 target 一条
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
    appendOrthoEdge(content, source.x + source.w, source.cy, t.x, t.cy, baseMarker, baseStroke, 1.2,
      sna ? actionKey(sna) : null,
      t.node.kind === 'action' ? actionKey(t.node as MappedAction & { row: number }) : null)
    return
  }

  const minTargetX = Math.min(...targets.map((t) => t.x))
  const bundleX = (source.x + source.w + minTargetX) / 2

  /** Trunk: source.right → bundleX（只画一次，不带箭头，避免在同一 x 叠多根箭头） */
  const trunk = d3.path()
  trunk.moveTo(source.x + source.w, source.cy)
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

  /** Branches: (bundleX, source.cy) → (bundleX, target.cy) → (target.x, target.cy) + 箭头 */
  for (const t of targets) {
    const tna = t.node.kind === 'action' ? (t.node as MappedAction & { row: number }) : null
    const stroke = tna?.forkGhost ? FORK_GHOST_STROKE : baseStroke
    const m = tna?.forkGhost ? ghostMarkerUrl : baseMarker
    const branch = d3.path()
    branch.moveTo(bundleX, source.cy)
    branch.lineTo(bundleX, t.cy)
    branch.lineTo(t.x, t.cy)
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
  /** 联动用：from / to action key（end 节点等无 key 时传 null） */
  fromKey: string | null = null,
  toKey: string | null = null
) {
  const mid = (x1 + x2) / 2
  const path = d3.path()
  path.moveTo(x1, y1)
  path.lineTo(mid, y1)
  path.lineTo(mid, y2)
  path.lineTo(x2, y2)
  const p = content
    .append('path')
    .attr('class', 'afv-edge')
    .attr('d', path.toString())
    .attr('fill', 'none')
    .attr('stroke', stroke)
    .attr('stroke-width', strokeWidth)
    .attr('marker-end', markerUrl)
    /** 避免边线盖住 action rect，否则悬停/右键命中 path 而非 rect */
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
 * 多条边汇入同一后继：共享同一竖直线 x = bundleX（位于最右前驱出口与后继左缘之间），再水平接入后继。
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
    appendOrthoEdge(
      content,
      s.x + s.w,
      s.cy,
      target.x,
      target.cy,
      m,
      stroke,
      1.2,
      actionKey(na),
      targetKey,
    )
    return
  }
  /**
   * 多条并行支线汇入同一后继：所有 source 在同一 bundleX 处折弯，
   * 共用「bundleX 竖直段 + bundleX → target 水平段 + 单个箭头」的主干，
   * 否则 N 条完整折线会让最后一段水平和箭头叠 N 次（视觉上有重影 / 抖动）。
   *
   * - 各 source 的支线（feeder）：source.right → (bundleX, source.cy) → (bundleX, target.cy)
   *   不带箭头，颜色按 source→target 的连线策略。
   * - 主干（trunk）：(bundleX, target.cy) → (target.x, target.cy)，带箭头，画 **一次**。
   *   颜色统一按「与 target 相邻」的非 ghost 走向（取首个非 ghost source；都是 ghost
   *   则按 ghost 走向），保持视觉收口干净。
   */
  const maxEnd = Math.max(...sources.map(s => s.x + s.w))
  const bundleX = (maxEnd + target.x) / 2

  for (const s of sources) {
    const na = s.node as MappedAction & { row: number }
    const { stroke } = joinStrokeForFanIn(na, target.node, markerUrl, ghostMarkerUrl)
    const path = d3.path()
    path.moveTo(s.x + s.w, s.cy)
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
  trunk.lineTo(target.x, target.cy)
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
   * 突出「更耗时」：仅当 `durationMs >= durationHighlightMinMs` 时保持正常亮度；
   * 更短的 action 暗化（与 `durationMode` / `colorMode` 无关）。
   */
  durationHighlightMinMs?: number | null
  /** 突出「更高 token」：仅当 `tokenEstimate >= tokenHighlightMin` 时保持正常亮度。 */
  tokenHighlightMin?: number | null
  /** 有阈值时自动滚动到第一个命中的 action（默认 true） */
  autoScrollFirstFilteredMatch?: boolean
  /**
   * 与 action 对应的原文查找表：须为 `segmentMessages` 与 `childBranchMessages` 的合并
   *（见 `mergeMessagesForActionTooltipLookup`），以便用 `partId` 对齐 rect 与 `OcMessagePart`。
   */
  tooltipMessages?: OcMessage[]
  onForkFromAction?: (action: MappedAction & { row: number }) => void
  onAnalyzeFromAction?: (action: MappedAction & { row: number }) => void
  /** 仅用于 UI 假数据演示：在某个 action 位置视觉分叉 */
  mockBranchForkActionIndex?: number
  /**
   * 为 false 时不绘制终点黄点（仍有 running/pending 的 action 时）。
   * 默认 true。
   */
  showFlowEndNode?: boolean
  /** 终点黄点悬停摘要；建议与 `showFlowEndNode` 同时传入 */
  flowEndSummary?: FlowEndSummary
  /** 嵌在父级双栏容器内时去掉内层描边，避免重复边框 */
  embedded?: boolean
  /** 限制可视区高度（px），用于上下分栏时每条 lane 固定高度可滚动 */
  viewportMaxHeight?: number
  /**
   * 为 true 时用 CSS 隐藏滚动条（仍可用滚轮滚动）。默认 false，保留系统滚动条以便可见溢出。
   */
  hideScrollbar?: boolean
  /**
   * 与左侧 treemap 联动：type-level 选中。匹配的 action group 保持原样，其他 group dim。
   */
  highlightedActionType?: string | null
  /**
   * 与左侧 treemap 联动：action-level 选中（单个 action 的 actionKey）。
   * 优先级高于 highlightedActionType；命中时仅该 action 高亮，其他暗化。
   */
  highlightedActionKey?: string | null
  /** 选中位于其他子任务时，本 ActionFlow 整体 dim */
  dimAll?: boolean
  /** ActionFlow rect 单击 → action-level 选中 */
  onSelectAction?: (actionKey: string | null) => void
  /**
   * Fork 对比模式：与 `actions` 中带 `forkCompareRow === 2` 的「新分支」动作配合 —
   * 传入 fork 锚点 action 的 `actionKey()`，layout 会从锚点右缘起算新分支独立 x 轨，
   * 并在锚点 → 第一条新分支动作之间绘制专门的「下沉」分叉边。
   */
  forkAnchorActionKey?: string | null
  /** 布局模式：timeline 为原始时序视图，packing 为紧凑堆叠视图。 */
  layoutMode?: FlowLayoutMode
  /** colorMode='type' 时使用的调色盘 */
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
  layoutMode = 'timeline',
  actionTypePaletteId = DEFAULT_ACTION_TYPE_PALETTE_ID,
}: Props) {
  const isPackingLayout = layoutMode === 'packing'
  /** packing 模式强制使用 type 色：颜色编码动作类型，比状态色在紧凑视图下更易读 */
  const effectiveColorMode: 'status' | 'tokens' | 'type' = isPackingLayout ? 'type' : colorMode
  const svgRef = useRef<SVGSVGElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [packingFitWidthPx, setPackingFitWidthPx] = useState<number | null>(null)
  const [contextMenu, setContextMenu] = useState<ActionFlowContextMenuState | null>(null)
  const reactId = useId().replace(/:/g, '')
  const markerId = `action-flow-arrow-${reactId}`
  const tooltipId = `action-flow-tip-${reactId}`
  /**
   * react-tooltip v5 的初始扫描 (querySelectorAll) 运行在 useEffect（paint 后），
   * 而 D3 绘制运行在 useLayoutEffect（paint 前）。理论上 D3 先完成，扫描后执行。
   *
   * 但实测发现：react-tooltip 内部 [anchorsBySelect, activeAnchor] effect 在
   * 扫描完成后立即触发 setActiveAnchor(anchors[0])，导致 activeAnchor dep 变化，
   * 进而重建 MutationObserver 和事件监听器 effect；在这段"重建空窗期"若用户
   * 已悬停，mouseenter 没有捕获到。
   *
   * 解决方案：延迟 Tooltip 挂载到首次渲染之后，保证 initial scan 运行时
   * SVG 内容已稳定，且 D3 在此次 useEffect 批次中不会再有属性写入。
   */
  const [tooltipMounted, setTooltipMounted] = useState(false)
  useEffect(() => {
    setTooltipMounted(true)
  }, [])
  const layoutEstimate = useMemo(
    () =>
      computeLayout(actions, durationMode, {
        includeEndNode: showFlowEndNode && !isPackingLayout,
        forkAnchorActionKey,
        layoutMode,
        packingFitWidthPx: isPackingLayout ? packingFitWidthPx : null,
      }),
    [
      actions,
      durationMode,
      showFlowEndNode,
      forkAnchorActionKey,
      layoutMode,
      isPackingLayout,
      packingFitWidthPx,
    ]
  )
  /**
   * 维持容器高度稳定：packing 仅压缩内部内容，不改变 ActionFlow 可视区域高度。
   * 基线高度取同一数据在 timeline 模式下的估算值，避免下方 MetricBox 行上移。
   */
  const timelineLayoutEstimate = useMemo(
    () =>
      computeLayout(actions, durationMode, {
        includeEndNode: showFlowEndNode,
        forkAnchorActionKey,
        layoutMode: 'timeline',
      }),
    [actions, durationMode, showFlowEndNode, forkAnchorActionKey]
  )

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !isPackingLayout) {
      setPackingFitWidthPx(null)
      return
    }
    const update = () => {
      const next = Math.max(220, Math.floor(el.clientWidth))
      setPackingFitWidthPx(prev => (prev === next ? prev : next))
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => update())
    ro.observe(el)
    return () => ro.disconnect()
  }, [isPackingLayout])

  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const root = d3.select(svg)
    root.selectAll('*').remove()

    const maxTok = Math.max(1, ...actions.map(a => a.tokenEstimate))
    const colorScale = d3.scaleSequential(d3.interpolateBlues).domain([0, maxTok])

    const { layout, totalW, totalH } = computeLayout(actions, durationMode, {
      includeEndNode: showFlowEndNode && !isPackingLayout,
      forkAnchorActionKey,
      layoutMode,
      packingFitWidthPx: isPackingLayout ? packingFitWidthPx : null,
    })
    /** 是否处于 fork 对比模式：layout 中存在任意「新分支」动作（含新分支里的 task / 子 session）。
     *  注意不能用 actionSessionKey===session:fork-new-branch 判断 —— 新分支 Subagent 的
     *  session key 已变成 task 子区域。 */
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

    /** 并行多 lane 汇入同一后继时由 `appendOrthoFanIn` 绘制，此处跳过避免重复折线 */
    const parallelJoinSkip = new Set<string>()
    /** 并行 fan-out 由 `appendOrthoFanOut` 统一画，跳过 main sequential loop 的重复边 */
    const parallelFanOutSkip = new Set<string>()

    if (!isPackingLayout) {
      /** 并行组：lane 内连线、前驱→各 lane 首、各 lane 末→后继（多源汇入同一 bundleX） */
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
       * 并行组前驱/后继的「搜索 session」。
       *
       * 问题根源：并行 Subagent task 的 actionSessionKey = 'session:task:callID'，
       * 而它们真正的前驱/后继在 session:main（或父 task 的 session）里——用 groupSession
       * 过滤会把真正的 pred/succ 全部排除，导致只有主循环画了一条相邻边，第二条永远缺失。
       *
       * 修正策略：
       * - Subagent（非 child-session）：它们由外部 session 发起，搜索范围 = 'session:main'
       *   （或更准确地：根节点发起的就是 main，嵌套的以 parentTaskCallID 定位）
       * - child-session 里的并行 action：搜索范围 = 'session:task:parentTaskCallID'
       * - 普通 main action：直接用 actionSessionKey
       *
       * 此外，fork 边界（ghost / new-branch）仍须单独过滤，防止跨分支。
       */
      const firstNode = groupActions[0]!.node
      const groupIsGhost = firstNode.forkGhost === true
      const groupIsNewBranch = isNewBranchAction(firstNode)

      /** 并行组的 "发起方 session"：pred/succ 所在的 session */
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

      /** 是否通过 fork 边界检查（只限于同一分叉轨道） */
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
         * 并行组没有显式后继时连到「自己泳道」的 end：
         *  - 普通模式：唯一一个 main end；
         *  - Fork 对比：main 组接 ghost end，fork-new-branch 组接 new branch end。
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
        /** 泳道内相邻连线 */
        for (let i = 0; i < sortedIdx.length - 1; i++) {
          const fromIdx = sortedIdx[i]!
          const toIdx = sortedIdx[i + 1]!
          const na = layout[fromIdx]!.node as MappedAction & { row: number }
          const nb = layout[toIdx]!.node as MappedAction & { row: number }
          const { stroke: forkStroke, markerUrl: forkMarker } = edgeStrokeAndMarker(na, nb, markerUrl, ghostMarkerUrl)
          appendOrthoEdge(
            content,
            layout[fromIdx]!.x + layout[fromIdx]!.w,
            layout[fromIdx]!.cy,
            layout[toIdx]!.x,
            layout[toIdx]!.cy,
            forkMarker,
            forkStroke,
            1.2
          )
        }
        firstIndices.push(sortedIdx[0]!)
        lastIndices.push(sortedIdx[sortedIdx.length - 1]!)
      }

      /**
       * Fan-out：pred → 各 lane 首，使用 appendOrthoFanOut 共享 bundleX，
       * 同时把所有 predIdx-firstIdx 对加入 parallelFanOutSkip，防止主循环重复画。
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

      /** Fan-in：各 lane 末 → succ，使用 appendOrthoFanIn 共享 bundleX */
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

    /** 是否属于 fork 之后的「分叉双轨」（ghost 历史尾迹 / 新分支）—— 这两条轨上的 sortTime
     *  会在合并后的 layout 里交错排列，「相邻成对」连线会被 cross-branch skip 全部杀掉，
     *  必须改用专门的「按 sortTime 在自身支线内」扫一遍。 */
    const isPostAnchor = (a: MappedAction & { row: number }) =>
      a.forkGhost === true || isNewBranchAction(a)

    for (let i = 0; i < layout.length - 1; i++) {
      const a = layout[i]!
      const b = layout[i + 1]!
      if (a.node.kind === 'action' && b.node.kind === 'action') {
        const pa = a.node as MappedAction & { row: number }
        const pb = b.node as MappedAction & { row: number }
        /**
         * Post-anchor 的相邻边一律跳过 —— ghost 与新分支因 sortTime 交错而错位，
         * 用相邻关系连线会漏掉同支线内的真正后继。两条支线的内部连线由后面专门的
         * `connectPostAnchorTrack` 各扫一次。
         */
        if (isPostAnchor(pa) && isPostAnchor(pb)) continue
        /**
         * Fork 比对：跨越「历史轨迹」与「新分支」之间的隐式相邻边一律跳过。
         * - anchor → 第一条新分支动作 由后续显式分叉边绘制；
         * - 末尾 ghost → 第一条新分支动作 不是真实连续关系（两条平行支线），不画。
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
       * 进入 end 节点的隐式相邻边一律跳过 —— end 的连接由后面「显式收尾」段统一画，
       * 既兼容普通模式（一个 end），也兼容 fork 对比（两个 end，各自只连本泳道最后一条 action）。
       */
      if (b.node.kind === 'end') continue
      const x1 = a.x + a.w
      const y1 = a.cy
      const x2 = b.x
      const y2 = b.cy
      const mid = (x1 + x2) / 2
      const path = d3.path()
      path.moveTo(x1, y1)
      path.lineTo(mid, y1)
      path.lineTo(mid, y2)
      path.lineTo(x2, y2)
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
      const p = content
        .append('path')
        .attr('class', 'afv-edge')
        .attr('d', path.toString())
        .attr('fill', 'none')
        .attr('stroke', segStroke)
        .attr('stroke-width', 1.2)
        .attr('marker-end', segMarker)
        .attr('pointer-events', 'none')
      if (fromKey) p.attr('data-from-key', fromKey)
      if (toKey) p.attr('data-to-key', toKey)
    }

    /**
     * 分叉支线内部按 sortTime 扫一遍，连相邻 action。
     * - ghost 历史尾迹（forkGhost=true）独立成轨；
     * - 新分支（forkCompareRow=2）独立成轨；
     * - 同一轨上不区分 session（与 fork 之前 main→Subagent→主流恢复 的视觉一致）；
     * - 跳过：Subagent→子会话首节点（由专门的紫色分叉边绘制）、并行同组兄弟、并行 fan-in
     *   已收走的对。
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
        appendOrthoEdge(
          content,
          ai.x + ai.w,
          ai.cy,
          bi.x,
          bi.cy,
          m,
          stroke,
          1.2,
          actionKey(pa),
          actionKey(pb),
        )
      }
    }
      connectPostAnchorTrack((a) => a.forkGhost === true)
      connectPostAnchorTrack(isNewBranchAction)
    }

    layout.forEach((item, layoutIndex) => {
      const { node, x: nx, y: ny, w, h } = item
      if (node.kind === 'end') {
        /**
         * Fork 对比模式下的「历史端」(sessionRegion='main' 且存在新分支) 用灰色圆，
         * 表示这是 fork 之前的旧轨迹收尾；新分支端 / 普通模式仍用 palette.end 黄色。
         * 历史端不显示 summary tooltip（数据是当下新 session 的，挂上去会误导）。
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
        effectiveColorMode,
        colorScale,
        actionTypePaletteId,
      )

      /** 每个 action 包一个 group：data-action-type 用于 type-level dim；data-action-key 用于 action-level dim 与点击 */
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
            .attr('stroke', 'none')
            .attr('stroke-width', 0)) as unknown as d3.Selection<
        SVGGraphicsElement,
        unknown,
        null,
        undefined
      >
      actionTarget
        .style('cursor', 'pointer')
        /**
         * UserRequest 是 transparent fill 的空心圆；默认 SVG hit-test 容易只命中圆环 stroke，
         * 鼠标在圆心时 target 会退到父级 svg，react-tooltip 就收不到 hover。
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
      /** 过滤状态显式写入，避免旧 DOM 复用时出现残留 dim */
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
        (act.status === 'running' || act.status === 'pending') &&
        effectiveColorMode === 'status'
      ) {
        actionTarget.attr('class', sc.isLongRunning ? 'action-flow-running-long' : 'action-flow-running')
      }

      const actionGNode = actionG.node() as SVGGElement | null
      const iconBox = isPackingLayout ? Math.max(6, Math.min(16, Math.min(w, h) - 4)) : 16
      const canShowIcon = !isUserRequest && (!isPackingLayout || w >= MIN_W)
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
      /** Duration mode: 块够宽时在左上角显示实际时长（替代旧的 >60s 阈值徽标） */
      if (durationMode && !isGhost && !isPackingLayout && w >= 52 && act.durationMs > 0) {
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

      /** 需求：任何情况下都不显示右上角三个点操作按钮 */
    })

    if (!isPackingLayout) {
      /**
       * 显式「收尾」连线：每个 end 节点 ← 本支线最右一条 action（按 x+w 取最右）。
       *  - 普通模式：唯一 main end ← 主会话最右 action。
       *  - Fork 对比：
       *      ghost end (sessionRegion='main') ← 历史最右 action（包括历史 task 子 session 末端）；
       *      new branch end (sessionRegion='fork-new-branch') ← 新分支最右 action（包括新分支
       *      task 子 session 末端）。
       *    判别用 forkCompareRow=2，而不是 actionSessionKey —— 否则新分支 task 区域里的最末
       *    动作会漏掉。
       *  - 已被并行组 fan-in 收走的 end 跳过（避免重复折线）。
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
        const right = it.x + it.w
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
      appendOrthoEdge(
        content,
        lastItem.x + lastItem.w,
        lastItem.cy,
        endItem.x,
        endItem.cy,
        marker,
        stroke,
        1.2,
        actionKey(lastAct),
        null,
      )
      }

      /**
       * Fork 对比显式分叉边：anchor 同时扇出到两条支线的起点：
       * - 历史 ghost 起点（fork 后旧轨迹）；
       * - 新分支起点（forkCompareRow=2）。
       *
       * 两个起点都按 sortTime 取最早的「父侧动作」（排除 child-session，避免直接连进子会话内部）。
       * 这样即使 ghost/new-branch 在合并时间轴里交错，anchor 也能稳定连到两条支线起点。
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
       * Fork 前缀兜底：确保「anchor 之前的历史主链」始终连续（1→2→...→anchor）。
       * 某些布局/分组下这段关系不一定是 layout 相邻项，会被通用相邻连线漏掉，
       * 这里按 sortTime 串起来并在 edge 不存在时补画。
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
            appendOrthoEdge(
              content,
              from.x + from.w,
              from.cy,
              to.x,
              to.cy,
              m,
              stroke,
              1.2,
              fromK,
              toK,
            )
          }
        }
      }

      /** 父 Subagent(task) → 子会话首节点 的紫色分叉 */
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
      const x1 = item.x + item.w
      const y1 = item.cy
      const x2 = firstChild.x
      const y2 = firstChild.cy
      const mid = (x1 + x2) / 2
      const branchPath = d3.path()
      branchPath.moveTo(x1, y1)
      branchPath.lineTo(mid, y1)
      branchPath.lineTo(mid, y2)
      branchPath.lineTo(x2, y2)
      const parentAct = node as MappedAction & { row: number }
      const childAct = firstChild.node as MappedAction & { row: number }
      const { stroke: branchStroke, markerUrl: branchMarker } = edgeStrokeAndMarker(
        parentAct,
        childAct,
        markerUrl,
        ghostMarkerUrl
      )
      content
        .append('path')
        .attr('class', 'afv-edge')
        .attr('d', branchPath.toString())
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
        // 与主流程边一致：水平 → 竖直 → 水平（中点取两端 x 的中点，避免出现斜线）
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
    }

    /** 边线先画、rect 后画时 rect 会压住 path；全部画完后把连线抬到最上层，避免「action 盖住线」 */
    content.selectAll<SVGPathElement, unknown>('path.afv-edge').raise()

    const desiredH = totalH + topOffset
    // 关键：使用像素级固定画布，不用 viewBox 缩放，避免不同行数时 action 尺寸变化
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
    effectiveColorMode,
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
    layoutMode,
    isPackingLayout,
    packingFitWidthPx,
  ])

  /**
   * 统一 dim 流：合并 selection（type / action）、阈值过滤、跨子任务 dim_All。
   * - dimAll：整张 ActionFlow 整体降透（其他子任务正在被选中）
   * - selection：type 命中或 action 命中 → 不在命中集合的 group dim
   * - duration：data-duration-dim=1 的 group dim（旧蓝环 / 黑遮罩 已被替换为这套统一 dim）
   * - 连线：仅当至少一端在命中集合 → 不 dim；否则 dim
   * 命中规则：
   *   - 优先 highlightedActionKey（action 级）→ 命中集合 = { 该 key }
   *   - 否则 highlightedActionType（type 级）→ 命中集合 = data-action-type === t 的所有 key
   *   - 都无 → 命中集合 = null（不做联动 dim，仅 duration dim 生效）
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

    /** 命中集合（action 级直接是单 key；type 级聚合所有同 type 的 key） */
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

    for (const g of groups) {
      const k = g.getAttribute('data-action-key') ?? ''
      const filterDimActive =
        highlightSet === null &&
        thresholdFilterActive &&
        g.getAttribute('data-filter-dim') === '1'
      const selDim = highlightSet !== null && !highlightSet.has(k)
      g.style.opacity = (selDim || filterDimActive) ? DIM : '1'
    }

    for (const e of edges) {
      const fk = e.getAttribute('data-from-key')
      const tk = e.getAttribute('data-to-key')
      let dim = false
      if (highlightSet !== null) {
        const fromHit = fk !== null && highlightSet.has(fk)
        const toHit = tk !== null && highlightSet.has(tk)
        dim = !fromHit && !toHit
      }
      /** 连线也尊重阈值过滤：两端都不达标则 dim */
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
  const timelineContentHeight = timelineLayoutEstimate.totalH + mockOffset
  /** 可视区域下限至少能容纳两行泳道，避免高度塌缩；上限仍限制最大可视高度，超出则内部滚动 */
  const minContentHeight = MIN_SVG_CONTENT_HEIGHT
  const maxVisibleHeight = Math.max(
    TOP_PAD + MAX_VISIBLE_ROWS * ROW_H + BLOCK_H + BOTTOM_PAD,
    minContentHeight
  )
  const normalViewportHeight = Math.min(Math.max(contentHeight, minContentHeight), maxVisibleHeight)
  const stablePackingViewportHeight = Math.min(
    Math.max(timelineContentHeight, minContentHeight),
    maxVisibleHeight
  )
  let viewportHeight = isPackingLayout ? stablePackingViewportHeight : normalViewportHeight
  if (typeof viewportMaxHeight === 'number' && Number.isFinite(viewportMaxHeight) && viewportMaxHeight > 0) {
    viewportHeight = Math.min(viewportHeight, viewportMaxHeight)
  }
  /** 仅作上限：内容较矮时不占满高度，避免「未溢出也出现滚动条」；超出 maxHeight 时才出现滚动条 */
  const scrollAreaMaxHeight = viewportHeight

  /** 内层滚动区不设 border：否则 box-sizing 下内容区 = maxHeight − 边框，易比 SVG 高度少 2px 而误出纵向条 */
  const scrollInner = (
    <div
      className={hideScrollbar ? 'action-flow-scroll--hide-scrollbar' : undefined}
      onClick={() => onSelectAction?.(null)}
      style={{
        boxSizing: 'border-box',
        overflowX: isPackingLayout ? 'hidden' : 'auto',
        overflowY: 'auto',
        width: '100%',
        flexShrink: 0,
        /** packing：固定容器高度并垂直居中 SVG；timeline：跟随内容高度，限制最大高度 */
        ...(isPackingLayout
          ? {
              height: stablePackingViewportHeight,
              display: 'flex',
              flexDirection: 'column' as const,
              justifyContent: 'center',
            }
          : {
              height: 'auto',
              maxHeight: scrollAreaMaxHeight,
              minHeight: 0,
            }),
      }}
      ref={scrollRef}
    >
      <svg
        ref={svgRef}
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
          /** 内层 overflow:auto 滚动会触发全局 scroll，默认会立刻关掉 tooltip */
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
