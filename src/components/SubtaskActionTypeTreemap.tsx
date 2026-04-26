import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as d3 from 'd3'
import { Tooltip } from 'react-tooltip'
import type { ActionType, MappedAction, OcMessage } from '../types/opencode'
import {
  buildTokenColorScale,
  resolveActionBlockColors,
} from '../utils/actionFlowColors'
import {
  type ActionTypePaletteId,
  DEFAULT_ACTION_TYPE_PALETTE_ID,
} from '../styles/actionTypePalettes'
import { appendActionFlowIcon, getActionFlowIconSvg } from './actionFlowIcons'
import { buildCompactMappedActionTooltipHtml } from '../utils/actionTooltipMapping'
import { actionKey } from '../utils/actionKey'

interface Props {
  actions: (MappedAction & { row: number })[]
  colorMode: 'status' | 'tokens' | 'type'
  actionTypePaletteId?: ActionTypePaletteId
  /** 画布宽度（px） */
  width: number
  /** 画布高度（px）；通常由父容器测量后传入以与卡片等高 */
  height: number
  /** 与 ActionFlowVisualization 同一份合并消息表，用于 mini block hover tooltip */
  tooltipMessages?: OcMessage[]
  /** type-level 选中：同 cell 高亮，其他 dim */
  selectedType?: string | null
  /** action-level 选中：仅该 mini-block 高亮 */
  selectedActionKey?: string | null
  /** 选中位于其他子任务时整体 dim */
  dimAll?: boolean
  /** cell 背景点击 → type-level 选中 */
  onSelectType?: (actionType: string | null) => void
  /** mini-block 点击 → action-level 选中 */
  onSelectAction?: (actionKey: string | null) => void
}

const SVG_FONT_SANS =
  "'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"

/** treemap 内 cell 之间间距 */
const REGION_PAD_INNER = 2
/** treemap 与外层 SVG 边框之间的留白 */
const REGION_OUTER_PAD = 4
/** cell 内边距（block 与 cell 边的距离） */
const REGION_INNER_PAD = 3
/** 单行 label 行高 */
const LABEL_LINE_H = 12
/** label 块与 icon 块之间留白 */
const LABEL_BAND_PAD = 2
/** label 最多渲染行数（超过则回落到无 label） */
const LABEL_MAX_LINES = 3
/**
 * 固定大小的 action mini block；所有 cell 内的 block 同样大小，
 * 这样不同 type 的 block 视觉权重一致，cell 面积仅由 squarified treemap 按 count 决定。
 */
const BLOCK_SIZE = 18
const BLOCK_GAP = 2
const BLOCK_RX = 3
const CELL_RX = 6
const CELL_STROKE = '#E8E8E8'
const CELL_STROKE_SELECTED = '#3D4F63'
const CELL_BG_SELECTED = 'rgba(61, 79, 99, 0.10)'
/** ×N 文字字号 */
const COUNT_TEXT_SIZE = 9
const COUNT_TEXT_W_EST = 18

type TypeBucket = {
  type: ActionType
  count: number
  /** 保持原始顺序的 actions，用于在区域内按时间序铺格 */
  actions: (MappedAction & { row: number })[]
}

function actionTypeLabel(type: ActionType): string {
  return type === 'UserRequest' ? 'user request' : type
}

function aggregateByType(actions: (MappedAction & { row: number })[]): TypeBucket[] {
  const map = new Map<ActionType, TypeBucket>()
  for (const a of actions) {
    let bucket = map.get(a.actionType)
    if (!bucket) {
      bucket = { type: a.actionType, count: 0, actions: [] }
      map.set(a.actionType, bucket)
    }
    bucket.count += 1
    bucket.actions.push(a)
  }
  return [...map.values()]
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '—'
  const sec = durationMs / 1000
  if (sec < 0.01) return '<0.01s'
  return `${sec.toFixed(2)}s`
}

/**
 * 平均字宽估算（font-size 10, weight 600）。CJK 字符占 1.0×fontSize，ASCII 约 0.55×。
 * 不需要精确，只用来粗算「能不能装下」并做降级。
 */
function estimateLabelWidth(text: string, fontSize = 10): number {
  let w = 0
  for (const ch of text) {
    if (/[\u3000-\u9FFF\uFF00-\uFFEF]/.test(ch)) w += fontSize
    else if (/[A-Z]/.test(ch)) w += fontSize * 0.65
    else if (/\d/.test(ch)) w += fontSize * 0.55
    else w += fontSize * 0.55
  }
  return w
}

/**
 * 把 actionType 智能拆成 ≤ maxLines 行：
 *   - 优先按驼峰边界拆（"WebFetch" → ["Web", "Fetch"]、"MCPCall" → ["MCP", "Call"]）
 *   - 拆完每行宽度都 ≤ usableW 才算成功
 *   - 不行就回落到等长字符切片
 *   - 都塞不下返回 null
 *
 * 永远不出现 "…" 截断。
 */
function splitTypeName(
  name: string,
  usableW: number,
  fontSize: number,
  maxLines: number,
): string[] | null {
  if (estimateLabelWidth(name, fontSize) <= usableW) return [name]
  /** 驼峰拆分尝试 */
  const camelParts = name.split(/(?=[A-Z])/).filter(Boolean)
  if (camelParts.length > 1) {
    const lines: string[] = []
    let cur = ''
    for (const p of camelParts) {
      const next = cur ? cur + p : p
      if (estimateLabelWidth(next, fontSize) <= usableW) {
        cur = next
      } else {
        if (cur) lines.push(cur)
        cur = p
      }
    }
    if (cur) lines.push(cur)
    if (
      lines.length <= maxLines &&
      lines.every((l) => estimateLabelWidth(l, fontSize) <= usableW)
    ) {
      return lines
    }
  }
  /** 兜底：等长字符切片 */
  const charsPerLine = Math.max(1, Math.floor(usableW / (fontSize * 0.62)))
  const lines: string[] = []
  for (let i = 0; i < name.length; i += charsPerLine) {
    lines.push(name.slice(i, i + charsPerLine))
  }
  if (lines.length <= maxLines) return lines
  return null
}

/**
 * 多行 label 选择策略（icon 在上、text 在下）：
 *   tier 1: ["Type×N (P%)"]    单行最详细
 *   tier 2: ["Type×N"]          省 (P%)
 *   tier 3: ["Type"]            省 ×N，仅 type name
 *   tier 4: 多行 type name 拆分（按驼峰 / 等长字符）
 *   tier 5: 拆不出 → 返回 [] 不渲染 label（绝不省略号截断）
 */
function pickLabelLines(
  type: string,
  count: number,
  pct: number,
  cellW: number,
  fontSize = 10,
): string[] {
  const usableW = Math.max(0, cellW - 4)
  if (usableW < fontSize * 0.7) return []
  const single: string[] = [
    `${type}×${count} (${pct}%)`,
    `${type}×${count}`,
    type,
  ]
  for (const s of single) {
    if (estimateLabelWidth(s, fontSize) <= usableW) return [s]
  }
  const wrapped = splitTypeName(type, usableW, fontSize, LABEL_MAX_LINES)
  return wrapped ?? []
}

function buildBucketTooltipHtml(bucket: TypeBucket, totalCount: number): string {
  const pct = Math.round((bucket.count / totalCount) * 100)
  return `<div class="action-tip-root action-tip-root--compact"><div class="action-tip-compact-main"><div class="action-tip-compact-head"><strong>${escapeHtml(actionTypeLabel(bucket.type))}</strong> <span class="action-tip-compact-status">×${bucket.count} (${pct}%)</span></div></div></div>`
}

export default function SubtaskActionTypeTreemap({
  actions,
  colorMode,
  actionTypePaletteId = DEFAULT_ACTION_TYPE_PALETTE_ID,
  width,
  height,
  tooltipMessages,
  selectedType = null,
  selectedActionKey = null,
  dimAll = false,
  onSelectType,
  onSelectAction,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const reactId = useId().replace(/:/g, '')
  const tooltipId = `subtask-tm-tip-${reactId}`
  const [tooltipMounted, setTooltipMounted] = useState(false)
  useEffect(() => { setTooltipMounted(true) }, [])

  const buckets = useMemo(() => aggregateByType(actions), [actions])
  const totalCount = useMemo(
    () => buckets.reduce((acc, b) => acc + b.count, 0),
    [buckets],
  )
  const tokenScale = useMemo(() => buildTokenColorScale(actions), [actions])

  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const root = d3.select(svg)
    root.selectAll('*').remove()
    root.attr('width', width).attr('height', height)
    /** 整体跨子任务 dim：treemap 容器整体降透明度 */
    root.style('opacity', dimAll ? '0.35' : '')

    if (totalCount === 0 || buckets.length === 0) {
      root
        .append('text')
        .attr('x', width / 2)
        .attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('font-family', SVG_FONT_SANS)
        .attr('font-size', 11)
        .attr('fill', '#B0B0B0')
        .text('No actions')
      return
    }

    /**
     * 单层 squarified treemap：
     *   一个 root，子节点 = 每个 actionType bucket，value = count
     */
    type HierDatum = { name: string; value?: number; bucket?: TypeBucket }
    const hierRoot: HierDatum = {
      name: 'root',
      bucket: undefined,
    }
    const hierChildren: HierDatum[] = buckets.map((b) => ({
      name: b.type,
      value: b.count,
      bucket: b,
    }))

    type RectNode = d3.HierarchyRectangularNode<HierDatum>
    const node = d3
      .hierarchy<HierDatum>(
        { ...hierRoot, ...({ children: hierChildren } as object) },
        (d) => ((d as unknown) as { children?: HierDatum[] }).children,
      )
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

    /** ratio=1 → squarify 偏向正方形 cell；缓解小 bucket 被切成超细窄条 */
    const tile = d3.treemapSquarify.ratio(1)
    const treemapNode = d3
      .treemap<HierDatum>()
      .tile(tile)
      .size([width, height])
      .paddingInner(REGION_PAD_INNER)
      .paddingOuter(REGION_OUTER_PAD)
      .round(true)(node) as RectNode

    const leaves = treemapNode.leaves()
    const contentNode = root.node() as SVGSVGElement | null

    leaves.forEach((leaf, leafIdx) => {
      const bucket = leaf.data.bucket
      if (!bucket) return
      const x0 = leaf.x0
      const y0 = leaf.y0
      const x1 = leaf.x1
      const y1 = leaf.y1
      const w = Math.max(0, x1 - x0)
      const h = Math.max(0, y1 - y0)
      if (w <= 0 || h <= 0) return

      const pct = Math.round((bucket.count / totalCount) * 100)
      const sortedActs = [...bucket.actions].sort((a, b) => a.sortTime - b.sortTime)
      const firstAct = sortedActs[0]!
      const repColors = resolveActionBlockColors(firstAct, colorMode, tokenScale, actionTypePaletteId)
      const compactTooltip = buildBucketTooltipHtml(bucket, totalCount)

      /** type-level 选中 */
      const isTypeSelected = selectedType === bucket.type
      /** action-level 选中：bucket 中是否包含该 action（决定 cell 整体亮 or 暗） */
      const bucketContainsSelectedAction =
        selectedActionKey !== null &&
        bucket.actions.some((a) => actionKey(a) === selectedActionKey)
      /** 是否该 cell 视为「主选中」：type 命中 或 包含 action 命中 */
      const isCellHighlighted = isTypeSelected || bucketContainsSelectedAction
      const isCellDimmed =
        (selectedType !== null && !isTypeSelected) ||
        (selectedActionKey !== null && !bucketContainsSelectedAction)

      const region = root
        .append('g')
        .attr('class', 'subtask-tm-region')
        .attr('data-action-type', bucket.type)
        .style('cursor', onSelectType ? 'pointer' : 'default')
      if (isCellDimmed) region.style('opacity', '0.30')

      /** cell 边框：默认淡灰描边，type 选中时主题色加粗 */
      const cellBg = region
        .append('rect')
        .attr('x', x0)
        .attr('y', y0)
        .attr('width', w)
        .attr('height', h)
        .attr('rx', CELL_RX)
        .attr('fill', isCellHighlighted ? CELL_BG_SELECTED : 'transparent')
        .attr('stroke', isTypeSelected ? CELL_STROKE_SELECTED : CELL_STROKE)
        .attr('stroke-width', isTypeSelected ? 1.5 : 1)
      if (onSelectType) {
        cellBg.style('cursor', 'pointer').on('click', (ev: Event) => {
          ev.stopPropagation()
          onSelectType(isTypeSelected ? null : bucket.type)
        })
      }

      /** ===== Tier 选择 ===== */
      const usableW = w - REGION_INNER_PAD * 2
      const usableH = h - REGION_INNER_PAD * 2
      const fitsLabelAndBlock =
        usableW >= BLOCK_SIZE && usableH >= LABEL_LINE_H + LABEL_BAND_PAD + BLOCK_SIZE
      const fitsBlockGrid = usableW >= BLOCK_SIZE && usableH >= BLOCK_SIZE
      /** 紧凑模式：cell 至少能装下 1 个 block + 数字（横/竖排） */
      const fitsCompactVertical = w >= BLOCK_SIZE + 2 && h >= BLOCK_SIZE + COUNT_TEXT_SIZE + 4
      const fitsCompactHorizontal = w >= BLOCK_SIZE + COUNT_TEXT_W_EST + 4 && h >= BLOCK_SIZE + 2

      if (fitsLabelAndBlock) {
        renderFullTier({
          region,
          x0,
          y0,
          w,
          h,
          bucket,
          pct,
          sortedActs,
        })
      } else if (fitsBlockGrid) {
        renderBlockOnlyTier({
          region,
          x0,
          y0,
          w,
          h,
          bucket,
          sortedActs,
        })
      } else if (fitsCompactVertical || fitsCompactHorizontal) {
        renderCompactTier({
          region,
          x0,
          y0,
          w,
          h,
          bucket,
          firstAct,
          repColors,
          compactTooltip,
          orientation: fitsCompactVertical ? 'vertical' : 'horizontal',
        })
      } else {
        renderDotTier({
          region,
          x0,
          y0,
          w,
          h,
          bucket,
          repColors,
          compactTooltip,
        })
      }

      // ----- inner helpers (共享 leafIdx / reactId / closures) -----
      function renderFullTier(p: {
        region: d3.Selection<SVGGElement, unknown, null, undefined>
        x0: number
        y0: number
        w: number
        h: number
        bucket: TypeBucket
        pct: number
        sortedActs: (MappedAction & { row: number })[]
      }) {
        /** 1) 先选 label（多行无省略），再算 icon 区可用高度，必要时减少行数 */
        const labelMaxW = p.w - REGION_INNER_PAD * 2
        let labelLines = pickLabelLines(actionTypeLabel(p.bucket.type), p.bucket.count, p.pct, labelMaxW)
        const iconMinH = BLOCK_SIZE
        while (labelLines.length > 0) {
          const labelTotalH = labelLines.length * LABEL_LINE_H + LABEL_BAND_PAD
          const remainH = p.h - labelTotalH - REGION_INNER_PAD * 2
          if (remainH >= iconMinH) break
          /** icon 区被挤太矮：丢一行 label */
          labelLines = labelLines.slice(0, -1)
        }
        const labelTotalH =
          labelLines.length > 0
            ? labelLines.length * LABEL_LINE_H + LABEL_BAND_PAD
            : 0

        /** 2) icons 在上 */
        const packAreaX = p.x0 + REGION_INNER_PAD
        const packAreaY = p.y0 + REGION_INNER_PAD
        const packAreaW = p.w - REGION_INNER_PAD * 2
        const packAreaH = p.h - labelTotalH - REGION_INNER_PAD * 2
        renderBlockGrid(p.region, packAreaX, packAreaY, packAreaW, packAreaH, p.sortedActs)

        /** 3) label 居中放 cell 底部，多行垂直堆叠；font-size 10、weight 600 */
        if (labelLines.length > 0) {
          const labelStartY = p.y0 + p.h - labelTotalH - REGION_INNER_PAD + LABEL_BAND_PAD
          labelLines.forEach((line, i) => {
            p.region
              .append('text')
              .attr('x', p.x0 + p.w / 2)
              .attr('y', labelStartY + (i + 1) * LABEL_LINE_H - 2.5)
              .attr('text-anchor', 'middle')
              .attr('font-family', SVG_FONT_SANS)
              .attr('font-size', 10)
              .attr('font-weight', 600)
              .attr('fill', '#5C5C5C')
              .text(line)
          })
        }
      }

      function renderBlockOnlyTier(p: {
        region: d3.Selection<SVGGElement, unknown, null, undefined>
        x0: number
        y0: number
        w: number
        h: number
        bucket: TypeBucket
        sortedActs: (MappedAction & { row: number })[]
      }) {
        const packAreaX = p.x0 + REGION_INNER_PAD
        const packAreaY = p.y0 + REGION_INNER_PAD
        const packAreaW = p.w - REGION_INNER_PAD * 2
        const packAreaH = p.h - REGION_INNER_PAD * 2
        renderBlockGrid(p.region, packAreaX, packAreaY, packAreaW, packAreaH, p.sortedActs)
      }

      function renderBlockGrid(
        region: d3.Selection<SVGGElement, unknown, null, undefined>,
        ax: number,
        ay: number,
        aw: number,
        ah: number,
        sortedActs: (MappedAction & { row: number })[],
      ) {
        const cols = Math.max(1, Math.floor((aw + BLOCK_GAP) / (BLOCK_SIZE + BLOCK_GAP)))
        const maxRows = Math.max(1, Math.floor((ah + BLOCK_GAP) / (BLOCK_SIZE + BLOCK_GAP)))
        const capacity = cols * maxRows
        const overflow = sortedActs.length > capacity
        const drawCount = overflow ? Math.max(0, capacity - 1) : sortedActs.length

        for (let i = 0; i < drawCount; i++) {
          const act = sortedActs[i]!
          const r = Math.floor(i / cols)
          const c = i % cols
          const bx = ax + c * (BLOCK_SIZE + BLOCK_GAP)
          const by = ay + r * (BLOCK_SIZE + BLOCK_GAP)
          const colors = resolveActionBlockColors(act, colorMode, tokenScale, actionTypePaletteId)

          const akey = actionKey(act)
          const isActSelected = selectedActionKey === akey
          const blockG = region
            .append('g')
            .attr('class', 'subtask-tm-block')
            .attr('data-action-key', akey)
          /** action-level 选中：本 block 单亮；本 cell 中其他 mini-block 暗 */
          if (selectedActionKey !== null && bucketContainsSelectedAction && !isActSelected) {
            blockG.style('opacity', '0.30')
          }
          /** 极淡底色 + 无外框；选中时加深底色 + 主题色描边 */
          const target = (act.actionType === 'UserRequest'
            ? blockG
                .append('circle')
                .attr('cx', bx + BLOCK_SIZE / 2)
                .attr('cy', by + BLOCK_SIZE / 2)
                .attr('r', BLOCK_SIZE / 2 - 3)
                .attr('fill', 'transparent')
                .attr('stroke', colors.iconFill)
                .attr('stroke-width', isActSelected ? 2 : 1.6)
            : blockG
                .append('rect')
                .attr('x', bx)
                .attr('y', by)
                .attr('width', BLOCK_SIZE)
                .attr('height', BLOCK_SIZE)
                .attr('rx', BLOCK_RX)
                .attr('fill', colors.fill)
                .attr('opacity', isActSelected ? 0.95 : 0.55)
                .attr('stroke', isActSelected ? CELL_STROKE_SELECTED : 'none')
                .attr('stroke-width', isActSelected ? 1.5 : 0)) as unknown as d3.Selection<
            SVGGraphicsElement,
            unknown,
            null,
            undefined
          >
          target
            .style('cursor', onSelectAction ? 'pointer' : 'default')
            .attr('pointer-events', 'all')
            .attr('data-tooltip-id', tooltipId)
            .attr('data-tooltip-html', buildCompactMappedActionTooltipHtml(act, tooltipMessages, formatDurationMs))
            .attr('data-tooltip-place', 'top')
            .on('click', (ev: Event) => {
              if (!onSelectAction) return
              ev.stopPropagation()
              onSelectAction(isActSelected ? null : akey)
            })

          if (contentNode && colorMode !== 'type' && act.actionType !== 'UserRequest') {
            appendActionFlowIcon(
              contentNode as unknown as SVGGElement,
              getActionFlowIconSvg(act.actionType),
              bx + BLOCK_SIZE / 2,
              by + BLOCK_SIZE / 2,
              colors.iconFill,
              `${reactId}-${leafIdx}-${i}-`,
            )
          }
        }

        if (overflow) {
          const i = drawCount
          const r = Math.floor(i / cols)
          const c = i % cols
          const bx = ax + c * (BLOCK_SIZE + BLOCK_GAP)
          const by = ay + r * (BLOCK_SIZE + BLOCK_GAP)
          const oG = region.append('g').attr('class', 'subtask-tm-overflow')
          oG.append('rect')
            .attr('x', bx)
            .attr('y', by)
            .attr('width', BLOCK_SIZE)
            .attr('height', BLOCK_SIZE)
            .attr('rx', BLOCK_RX)
            .attr('fill', '#F0F0F0')
            .attr('stroke', '#C6C6C6')
            .attr('stroke-width', 1)
          oG.append('text')
            .attr('x', bx + BLOCK_SIZE / 2)
            .attr('y', by + BLOCK_SIZE / 2 + 3)
            .attr('text-anchor', 'middle')
            .attr('font-family', SVG_FONT_SANS)
            .attr('font-size', 9)
            .attr('font-weight', 600)
            .attr('fill', '#5C5C5C')
            .text(`+${sortedActs.length - drawCount}`)
        }
      }

      function renderCompactTier(p: {
        region: d3.Selection<SVGGElement, unknown, null, undefined>
        x0: number
        y0: number
        w: number
        h: number
        bucket: TypeBucket
        firstAct: MappedAction & { row: number }
        repColors: { fill: string; stroke: string; iconFill: string }
        compactTooltip: string
        orientation: 'vertical' | 'horizontal'
      }) {
        const cx = p.x0 + p.w / 2
        const cy = p.y0 + p.h / 2

        let bx: number, by: number, tx: number, ty: number, tAnchor: string
        if (p.orientation === 'vertical') {
          // 上 icon 下 ×N
          const totalH = BLOCK_SIZE + 2 + COUNT_TEXT_SIZE
          const startY = cy - totalH / 2
          bx = cx - BLOCK_SIZE / 2
          by = startY
          tx = cx
          ty = startY + BLOCK_SIZE + COUNT_TEXT_SIZE + 1
          tAnchor = 'middle'
        } else {
          // 左 icon 右 ×N
          const totalW = BLOCK_SIZE + 3 + COUNT_TEXT_W_EST
          const startX = cx - totalW / 2
          bx = startX
          by = cy - BLOCK_SIZE / 2
          tx = startX + BLOCK_SIZE + 3
          ty = cy + 4
          tAnchor = 'start'
        }

        const akey = actionKey(p.firstAct)
        const blockG = p.region
          .append('g')
          .attr('class', 'subtask-tm-compact')
          .attr('data-action-key', akey)
        /** 紧凑档：普通 action 去掉方框只保留图标；UserRequest 保持空心圆。 */
        const compactTarget = (p.firstAct.actionType === 'UserRequest'
          ? blockG
              .append('circle')
              .attr('cx', bx + BLOCK_SIZE / 2)
              .attr('cy', by + BLOCK_SIZE / 2)
              .attr('r', BLOCK_SIZE / 2 - 3)
              .attr('fill', 'transparent')
              .attr('stroke', p.repColors.iconFill)
              .attr('stroke-width', 1.6)
          : blockG
              .append('rect')
              .attr('x', bx)
              .attr('y', by)
              .attr('width', BLOCK_SIZE)
              .attr('height', BLOCK_SIZE)
              .attr('rx', BLOCK_RX)
              .attr('fill', 'transparent')) as unknown as d3.Selection<
          SVGGraphicsElement,
          unknown,
          null,
          undefined
        >
        compactTarget
          .style('cursor', onSelectAction ? 'pointer' : 'default')
          .attr('pointer-events', 'all')
          .attr('data-tooltip-id', tooltipId)
          .attr('data-tooltip-html', p.compactTooltip)
          .attr('data-tooltip-place', 'top')
          .on('click', (ev: Event) => {
            if (!onSelectAction) return
            ev.stopPropagation()
            onSelectAction(selectedActionKey === akey ? null : akey)
          })

        if (contentNode && colorMode !== 'type' && p.firstAct.actionType !== 'UserRequest') {
          appendActionFlowIcon(
            contentNode as unknown as SVGGElement,
            getActionFlowIconSvg(p.firstAct.actionType),
            bx + BLOCK_SIZE / 2,
            by + BLOCK_SIZE / 2,
            p.repColors.iconFill,
            `${reactId}-${leafIdx}-cmp-`,
          )
        }

        p.region
          .append('text')
          .attr('x', tx)
          .attr('y', ty)
          .attr('text-anchor', tAnchor)
          .attr('font-family', SVG_FONT_SANS)
          .attr('font-size', COUNT_TEXT_SIZE)
          .attr('font-weight', 600)
          .attr('fill', '#5C5C5C')
          .text(`×${p.bucket.count}`)
      }

      function renderDotTier(p: {
        region: d3.Selection<SVGGElement, unknown, null, undefined>
        x0: number
        y0: number
        w: number
        h: number
        bucket: TypeBucket
        repColors: { fill: string; stroke: string; iconFill: string }
        compactTooltip: string
      }) {
        const cx = p.x0 + p.w / 2
        const cy = p.y0 + p.h / 2
        const r = Math.max(2, Math.min(5, Math.min(p.w, p.h) / 3))
        const isUserRequest = p.bucket.type === 'UserRequest'
        p.region
          .append('circle')
          .attr('cx', cx)
          .attr('cy', cy)
          .attr('r', r)
          .attr('fill', isUserRequest ? 'transparent' : p.repColors.iconFill)
          .attr('stroke', isUserRequest ? p.repColors.iconFill : 'none')
          .attr('stroke-width', isUserRequest ? 1.4 : 0)
          .style('cursor', 'pointer')
          .attr('pointer-events', 'all')
          .attr('data-tooltip-id', tooltipId)
          .attr('data-tooltip-html', p.compactTooltip)
          .attr('data-tooltip-place', 'top')
      }
    })
  }, [
    buckets,
    totalCount,
    tokenScale,
    width,
    height,
    colorMode,
    actionTypePaletteId,
    tooltipMessages,
    reactId,
    tooltipId,
    selectedType,
    selectedActionKey,
    dimAll,
    onSelectType,
    onSelectAction,
  ])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        flexShrink: 0,
      }}
    >
      {/* 外层不再加边框/背景：treemap 直接漂在卡片内空白处，避免「面板套面板」 */}
      <div
        style={{
          boxSizing: 'border-box',
          width,
          height,
          position: 'relative',
        }}
      >
        <svg ref={svgRef} style={{ display: 'block' }} />
      </div>
      {tooltipMounted && (
        <Tooltip
          id={tooltipId}
          anchorSelect={`[data-tooltip-id="${tooltipId}"]`}
          className="action-flow-react-tooltip"
          variant="light"
          positionStrategy="fixed"
          delayShow={120}
          delayHide={180}
          opacity={1}
          clickable
          globalCloseEvents={{ scroll: false, resize: true, escape: true }}
          arrowColor="#f8fafc"
        />
      )}
    </div>
  )
}
