import { Fragment, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { sankey as d3Sankey, sankeyLinkHorizontal } from 'd3-sankey'
import type { SankeyLink, SankeyNode } from 'd3-sankey'
import type { ActionType, MappedAction, OcMessage } from '../types/opencode'
import type { AssistantSubtask } from '../utils/subtaskGrouping'
import type { ForkFromActionContext, ForkPanelSnapshotBundle } from '../utils/forkPanelSnapshot'
import SubtaskCard from './SubtaskCard'
import ActionTypeColorLegend from './ActionTypeColorLegend'
import {
  type ActionTypePaletteId,
  DEFAULT_ACTION_TYPE_PALETTE_ID,
  getActionTypeTriad,
} from '../styles/actionTypePalettes'
import { buildMappedActionsFromMessages, collectTaskChildDescriptors } from '../utils/actionMapping'
import { actionKey } from '../utils/actionKey'
import { getMessages } from '../services/opencodeApi'

interface SubtaskDebugPanelProps {
  messages: OcMessage[]
  visibleSubtasks: Array<{ subtask: AssistantSubtask; sourceIndex: number }>
  linkedSubtaskIndex: number | null
  onSelectSubtask: (index: number) => void
  onForkFromAction?: (action: MappedAction & { row: number }, ctx: ForkFromActionContext) => void
  onAnalyzeFromAction?: (action: MappedAction & { row: number }) => void
  listScrollRef?: RefObject<HTMLDivElement | null>
  sessionDirectory?: string
  /** Fork 后新 session：本地保存的 fork 前子任务面板可视化快照 */
  forkPanelSnapshotBundle?: ForkPanelSnapshotBundle | null
  /** 全屏 packing view：>0 时每张子任务卡左侧前置一个 actionType treemap */
  leadingTreemapSize?: number
  /** 联动选中：type 级 / action 级 / 无 */
  selection?:
    | { kind: 'type'; subtaskIndex: number; actionType: string }
    | { kind: 'action'; subtaskIndex: number; actionKey: string; source: 'treemap' | 'flow' }
    | null
  /** treemap cell 点击回调；传入 null 取消选中 */
  onSelectActionType?: (subtaskIndex: number, actionType: string | null) => void
  /** treemap mini-block 或 ActionFlow rect 单击 → action-level 选中 */
  onSelectAction?: (
    subtaskIndex: number,
    actionKey: string | null,
    source?: 'treemap' | 'flow',
  ) => void
  /** 全局布局模式（由子任务面板头部统一切换） */
  flowLayoutMode?: 'timeline' | 'packing' | 'summary' | 'sankey'
}

type SankeyRawNode = {
  id: string
  step: number
  actionType: ActionType
}

type SankeyRawLink = {
  source: string
  target: string
  value: number
}

type SankeyNodeEx = SankeyNode<SankeyRawNode, SankeyRawLink> & SankeyRawNode
type SankeyLinkEx = SankeyLink<SankeyRawNode, SankeyRawLink> & SankeyRawLink

const sankeyLinkPath = sankeyLinkHorizontal<SankeyRawNode, SankeyRawLink>()

/** 子任务少时，单列 bar 高度上限（再挤不下时整图会整体缩小以塞进视口） */
const SANKEY_MAX_NODE_BAR_PX = 56
/**
 * bar 与「相邻列间空隙」的比例：留空 = barWidth * ratio（ratio 越大 bar 越窄、连线越易辨认）
 * 例：1.5 即空隙约等于 1.5 倍条宽
 */
const SANKEY_GAP_PER_BAR = 1.5

export default function SubtaskDebugPanel({
  messages,
  visibleSubtasks,
  linkedSubtaskIndex,
  onSelectSubtask,
  onForkFromAction,
  onAnalyzeFromAction,
  listScrollRef,
  sessionDirectory,
  forkPanelSnapshotBundle = null,
  leadingTreemapSize,
  selection = null,
  onSelectActionType,
  onSelectAction,
  flowLayoutMode = 'timeline',
}: SubtaskDebugPanelProps) {
  const [colorBy, setColorBy] = useState<'tokens' | 'type'>('type')
  const actionTypePaletteId: ActionTypePaletteId = DEFAULT_ACTION_TYPE_PALETTE_ID
  const [childSessionMessages, setChildSessionMessages] = useState<Record<string, OcMessage[]>>({})
  const summaryViewportRef = useRef<HTMLDivElement | null>(null)
  const [summaryViewportSize, setSummaryViewportSize] = useState({ width: 0, height: 0 })
  const sankeyViewportRef = useRef<HTMLDivElement | null>(null)
  const [sankeyViewportSize, setSankeyViewportSize] = useState({ width: 0, height: 0 })

  const summarySegments = useMemo(
    () =>
      visibleSubtasks.map(({ subtask, sourceIndex }, rowIndex) => {
        const indices = [...(subtask.userMessageIndices ?? []), ...subtask.assistantMessageIndices].sort(
          (a, b) => a - b,
        )
        const segmentMessages = indices
          .map((i) => messages[i])
          .filter((m): m is OcMessage => m != null)
        const parentActions = buildMappedActionsFromMessages(segmentMessages)
        const childDescriptors = collectTaskChildDescriptors(segmentMessages)
        return {
          sourceIndex,
          rowIndex,
          subtaskId: subtask.subtask_id,
          parentActions,
          childDescriptors,
        }
      }),
    [visibleSubtasks, messages],
  )

  useEffect(() => {
    if (flowLayoutMode !== 'summary' && flowLayoutMode !== 'sankey') return
    const ids = Array.from(
      new Set(summarySegments.flatMap((seg) => seg.childDescriptors.map((d) => d.childSessionID))),
    )
    if (ids.length === 0) return
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        ids.map(async (sid) => {
          try {
            const msgs = await getMessages(sid, `summary child session ${sid.slice(0, 8)}`, sessionDirectory)
            return [sid, msgs] as const
          } catch {
            return [sid, [] as OcMessage[]] as const
          }
        }),
      )
      if (cancelled) return
      setChildSessionMessages((prev) => {
        const next = { ...prev }
        for (const [sid, msgs] of entries) next[sid] = msgs
        return next
      })
    })()
    return () => {
      cancelled = true
    }
  }, [summarySegments, flowLayoutMode, sessionDirectory])

  useEffect(() => {
    if (flowLayoutMode !== 'summary') return
    const el = summaryViewportRef.current
    if (!el) return
    const update = () => {
      setSummaryViewportSize({ width: el.clientWidth, height: el.clientHeight })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [flowLayoutMode])

  useEffect(() => {
    if (flowLayoutMode !== 'sankey') return
    const el = sankeyViewportRef.current
    if (!el) return
    const update = () => {
      setSankeyViewportSize({ width: el.clientWidth, height: el.clientHeight })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [flowLayoutMode])

  const summaryRows = summarySegments.map(({ sourceIndex, rowIndex, subtaskId, parentActions, childDescriptors }) => {
    const childActions = childDescriptors.flatMap((desc) => {
      const msgs = childSessionMessages[desc.childSessionID] ?? []
      return buildMappedActionsFromMessages(msgs).map((a, i) => ({
        ...a,
        /** 锚定到 parent task 后面，保证同一子任务内时序可读 */
        sortTime: desc.anchorSortTime + 0.0005 + i * 0.0000001,
      }))
    })
    const actions = [...parentActions, ...childActions].sort((a, b) => a.sortTime - b.sortTime)
    return {
      sourceIndex,
      rowIndex,
      actions,
      subtaskId,
      sequenceSignature: actions.map((a) => a.actionType),
    }
  })
  /**
   * 分层分组排序（无标题）：
   * action1 相同聚在一起；组内再按 action2；再按 action3... 递归比较。
   */
  const summaryRowsSorted = [...summaryRows].sort((a, b) => {
    const n = Math.min(a.sequenceSignature.length, b.sequenceSignature.length)
    for (let i = 0; i < n; i++) {
      const cmp = a.sequenceSignature[i]!.localeCompare(b.sequenceSignature[i]!, 'en')
      if (cmp !== 0) return cmp
    }
    if (a.sequenceSignature.length !== b.sequenceSignature.length) {
      return a.sequenceSignature.length - b.sequenceSignature.length
    }
    return a.rowIndex - b.rowIndex
  })
  const summaryLayout = useMemo(() => {
    const DEFAULT_BLOCK_W = 28
    const DEFAULT_BLOCK_H = 36
    const ROW_LABEL_W = 28
    const rowCount = Math.max(1, summaryRowsSorted.length)
    const maxActionCount = Math.max(1, ...summaryRowsSorted.map((r) => r.actions.length))
    const availableW = Math.max(1, summaryViewportSize.width - ROW_LABEL_W)
    const availableH = Math.max(1, summaryViewportSize.height)
    const blockWidth = Math.max(2, Math.floor(Math.min(DEFAULT_BLOCK_W, availableW / maxActionCount)))
    const blockHeight = Math.max(2, Math.floor(Math.min(DEFAULT_BLOCK_H, availableH / rowCount)))
    return { blockWidth, blockHeight, rowLabelWidth: ROW_LABEL_W }
  }, [summaryRowsSorted, summaryViewportSize.width, summaryViewportSize.height])

  const summaryPanel = (
    <div
      ref={summaryViewportRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        padding: 0,
        border: 'none',
        borderRadius: 0,
        background: 'transparent',
      }}
    >
      {summaryRowsSorted.length === 0 ? (
        <span style={{ color: '#AAA', fontSize: 11 }}>暂无子任务</span>
      ) : (
        summaryRowsSorted.map((row) => {
          return (
            <div key={`${row.subtaskId}:${row.sourceIndex}:${row.rowIndex}`}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0,
                  margin: 0,
                  height: summaryLayout.blockHeight,
                }}
              >
                <span
                  style={{
                    width: summaryLayout.rowLabelWidth,
                    flexShrink: 0,
                    textAlign: 'right',
                    fontSize: 10,
                    fontWeight: 600,
                    color: '#7A7A7A',
                    paddingRight: 0,
                  }}
                  title={`Subtask #${row.rowIndex + 1}`}
                >
                  #{row.rowIndex + 1}
                </span>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    height: summaryLayout.blockHeight,
                    padding: 0,
                  }}
                >
                  {row.actions.length === 0 ? (
                    <span style={{ color: '#B0B0B0', fontSize: 10 }}>No actions</span>
                  ) : (
                    row.actions.map((action) => {
                      const paletteTriad = getActionTypeTriad(actionTypePaletteId, action.actionType)
                      const tooltip = [
                        `Subtask #${row.rowIndex + 1}`,
                        `Step: ${(action.partIndex ?? 0) + 1}`,
                        `Type: ${action.actionType}`,
                        `Status: ${action.status}`,
                        `Duration: ${Math.max(0, Math.round(action.durationMs))}ms`,
                        `Tokens: ${Math.max(0, Math.round(action.tokenEstimate))}`,
                      ].join('\n')
                      return (
                        <span
                          key={actionKey(action)}
                          title={tooltip}
                          style={{
                            width: summaryLayout.blockWidth,
                            height: summaryLayout.blockHeight,
                            borderRadius: 0,
                            flexShrink: 0,
                            background: action.actionType === 'UserRequest' ? '#8F8F8F' : paletteTriad.fill,
                            border: 'none',
                          }}
                        />
                      )
                    })
                  )}
                </div>
              </div>
            </div>
          )
        })
      )}
    </div>
  )

  const sankeyLayout = useMemo(() => {
    const rowsForSankey = summaryRowsSorted.filter((row) => row.actions.length >= 2)
    const stepCount = Math.max(0, ...rowsForSankey.map((row) => row.actions.length))
    if (stepCount < 2) {
      return {
        stepCount: 0,
        nodes: [] as SankeyNodeEx[],
        links: [] as SankeyLinkEx[],
        nodesById: new Map<string, SankeyNodeEx>(),
        columnX: [] as number[],
        width: 0,
        height: 0,
      }
    }

    const nodeSet = new Map<string, SankeyRawNode>()
    const linkStats = new Map<string, SankeyRawLink>()
    const nodesPerStep = new Map<number, Set<string>>()

    for (const row of rowsForSankey) {
      for (let i = 0; i < row.actions.length; i++) {
        const actionType = row.actions[i]!.actionType as ActionType
        const nodeId = `${i}|${actionType}`
        if (!nodeSet.has(nodeId)) nodeSet.set(nodeId, { id: nodeId, step: i, actionType })
        const col = nodesPerStep.get(i) ?? new Set<string>()
        col.add(nodeId)
        nodesPerStep.set(i, col)
      }
      for (let i = 0; i < row.actions.length - 1; i++) {
        const sourceType = row.actions[i]!.actionType as ActionType
        const targetType = row.actions[i + 1]!.actionType as ActionType
        const source = `${i}|${sourceType}`
        const target = `${i + 1}|${targetType}`
        const key = `${source}->${target}`
        const item = linkStats.get(key)
        if (item) item.value += 1
        else linkStats.set(key, { source, target, value: 1 })
      }
    }

    const width = Math.max(1, sankeyViewportSize.width)
    const height = Math.max(1, sankeyViewportSize.height)
    const LEFT = 68
    const RIGHT = 24
    const TOP = 18
    const BOTTOM = 12
    const innerW = width - LEFT - RIGHT
    const innerH = height - TOP - BOTTOM
    const maxNodesInColumn = Math.max(1, ...Array.from(nodesPerStep.values()).map((s) => s.size))
    const nodePadding = Math.max(5, Math.min(16, Math.floor(innerH / (maxNodesInColumn + 2))))
    /**
     * bar 宽度：随 step 数缩小；empty = bar * SANKEY_GAP_PER_BAR。
     * innerW = n*bar + (n-1)*(bar*ratio) = bar * (n + ratio*(n-1))
     */
    const nCol = stepCount
    const denom = nCol + SANKEY_GAP_PER_BAR * Math.max(0, nCol - 1)
    const nodeWidth = Math.max(3, Math.min(20, Math.floor(innerW / Math.max(4, denom))))
    const engine = d3Sankey<SankeyRawNode, SankeyRawLink>()
      .nodeId((d) => d.id)
      .nodeAlign((node) => node.step)
      .nodeSort((a, b) => a.actionType.localeCompare(b.actionType, 'en'))
      .nodeWidth(nodeWidth)
      .nodePadding(nodePadding)
      .extent([
        [LEFT, TOP],
        [Math.max(LEFT + 1, width - RIGHT), Math.max(TOP + 1, height - BOTTOM)],
      ])

    const graph = engine({
      nodes: Array.from(nodeSet.values()).map((n) => ({ ...n })),
      links: Array.from(linkStats.values()).map((l) => ({ ...l })),
    })
    const nodes = graph.nodes as SankeyNodeEx[]
    const links = graph.links as SankeyLinkEx[]

    const kx = nCol > 1 ? (innerW - nodeWidth) / (nCol - 1) : 0
    for (const node of nodes) {
      const i = node.step
      node.x0 = LEFT + i * kx
      node.x1 = node.x0 + nodeWidth
    }

    const maxH = Math.max(1, ...nodes.map((n) => (n.y1 ?? 0) - (n.y0 ?? 0)))
    const minY = Math.min(...nodes.map((n) => n.y0 ?? 0))
    const maxY = Math.max(...nodes.map((n) => n.y1 ?? 0))
    const contentH = Math.max(1, maxY - minY)
    const scaleH = Math.min(
      1,
      innerH / contentH,
      maxH > SANKEY_MAX_NODE_BAR_PX ? SANKEY_MAX_NODE_BAR_PX / maxH : 1,
    )
    const offY = TOP + (innerH - contentH * scaleH) / 2
    for (const node of nodes) {
      node.y0 = offY + ((node.y0 ?? 0) - minY) * scaleH
      node.y1 = offY + ((node.y1 ?? 0) - minY) * scaleH
    }
    for (const link of links) {
      link.y0 = offY + ((link.y0 ?? 0) - minY) * scaleH
      link.y1 = offY + ((link.y1 ?? 0) - minY) * scaleH
      const w0 = link.width ?? 0
      link.width = w0 * scaleH
    }

    const nodesById = new Map(nodes.map((n) => [n.id, n]))
    const columnX = Array.from({ length: stepCount }, (_, step) => LEFT + step * kx + nodeWidth / 2)
    const displayLinks = links.filter((l) => {
      const s = l.source
      const t = l.target
      if (typeof s !== 'object' || typeof t !== 'object') return false
      return (t as SankeyNodeEx).step === (s as SankeyNodeEx).step + 1
    })

    return {
      stepCount,
      nodes,
      links: displayLinks,
      nodesById,
      columnX,
      width,
      height,
    }
  }, [summaryRowsSorted, sankeyViewportSize.width, sankeyViewportSize.height])

  const sankeyPanel = (
    <div
      ref={sankeyViewportRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'stretch',
      }}
    >
      {sankeyLayout.stepCount < 2 ? (
        <span style={{ color: '#AAA', fontSize: 11 }}>至少需要两步 action 才能绘制 sankey</span>
      ) : (
        <svg width="100%" height="100%" viewBox={`0 0 ${sankeyLayout.width} ${sankeyLayout.height}`}>
          <defs>
            {sankeyLayout.links.map((link, i) => {
              const sourceNode = typeof link.source === 'object' ? (link.source as SankeyNodeEx) : null
              const targetNode = typeof link.target === 'object' ? (link.target as SankeyNodeEx) : null
              if (!sourceNode || !targetNode) return null
              const sourceColor = getActionTypeTriad(actionTypePaletteId, sourceNode.actionType).stroke
              const targetColor = getActionTypeTriad(actionTypePaletteId, targetNode.actionType).stroke
              const sx = sourceNode.x1 ?? 0
              const sy = link.y0 ?? 0
              const tx = targetNode.x0 ?? 0
              const ty = link.y1 ?? 0
              const g0x = Math.min(sx, tx)
              const g1x = Math.max(sx, tx)
              const c0 = sx <= tx ? sourceColor : targetColor
              const c1 = sx <= tx ? targetColor : sourceColor
              return (
                <linearGradient
                  key={`${sourceNode.id}→${targetNode.id}`}
                  id={`sankey-grad-${i}`}
                  gradientUnits="userSpaceOnUse"
                  x1={g0x}
                  y1={sy}
                  x2={g1x}
                  y2={ty}
                >
                  <stop offset="0%" stopColor={c0} />
                  <stop offset="100%" stopColor={c1} />
                </linearGradient>
              )
            })}
          </defs>
          {Array.from({ length: sankeyLayout.stepCount }, (_, i) => {
            const x = sankeyLayout.columnX[i] ?? 0
            return (
              <text
                key={`step-label-${i}`}
                x={x}
                y={10}
                textAnchor="middle"
                dominantBaseline="hanging"
                style={{ fontSize: 9, fill: '#8A8A8A', fontWeight: 600 }}
              >
                Step {i + 1}
              </text>
            )
          })}
          {sankeyLayout.links.map((link, i) => {
            const sourceNode = typeof link.source === 'object' ? (link.source as SankeyNodeEx) : null
            const targetNode = typeof link.target === 'object' ? (link.target as SankeyNodeEx) : null
            if (!sourceNode || !targetNode) return null
            const pathD =
              sankeyLinkPath(link as SankeyLink<SankeyRawNode, SankeyRawLink>) ?? ''
            return (
              <path
                key={`${sourceNode.id}->${targetNode.id}`}
                d={pathD}
                fill="none"
                stroke={`url(#sankey-grad-${i})`}
                strokeWidth={Math.max(1, link.width ?? 1)}
              >
                <title>{`${sourceNode.actionType} → ${targetNode.actionType}\nCount: ${link.value}`}</title>
              </path>
            )
          })}
          {sankeyLayout.nodes.map((node) => {
            const triad = getActionTypeTriad(actionTypePaletteId, node.actionType)
            const h = Math.max(0, (node.y1 ?? 0) - (node.y0 ?? 0))
            const x = node.x0 ?? 0
            const y = node.y0 ?? 0
            const w = Math.max(0, (node.x1 ?? 0) - (node.x0 ?? 0))
            return (
              <g key={node.id}>
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  fill={node.actionType === 'UserRequest' ? '#8F8F8F' : triad.stroke}
                  fillOpacity={1}
                  stroke="none"
                  rx={2}
                >
                  <title>{`${node.actionType}\nStep: ${node.step + 1}\nWeight: ${Math.round(node.value ?? 0)}`}</title>
                </rect>
                {h >= 12 ? (
                  <text
                    x={(node.x1 ?? 0) + 4}
                    y={(node.y0 ?? 0) + Math.min(h - 2, 10)}
                    style={{ fontSize: 9, fill: '#6A6A6A' }}
                  >
                    {node.actionType}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
      }}
    >
      <div
        style={{
          flexShrink: 0,
          padding: '0 0 8px',
          borderBottom: '1px solid #E8E8E8',
          marginBottom: 8,
        }}
      >
        <ActionTypeColorLegend
          paletteId={actionTypePaletteId}
        />
      </div>
      <div
        ref={listScrollRef}
        style={{
          flex: 1,
          overflowY: flowLayoutMode === 'summary' || flowLayoutMode === 'sankey' ? 'hidden' : 'auto',
          fontSize: 11,
          color: '#333',
          lineHeight: 1.45,
        }}
      >
        {flowLayoutMode === 'summary' ? (
          summaryPanel
        ) : flowLayoutMode === 'sankey' ? (
          sankeyPanel
        ) : visibleSubtasks.length === 0 ? (
          <span style={{ color: '#AAA', fontSize: 11 }}>暂无子任务</span>
        ) : (
          visibleSubtasks.map(({ subtask: st, sourceIndex }, si) => (
            <Fragment
              key={`${st.subtask_id}:${sourceIndex}:${st.assistantMessageIndices[0] ?? -1}:${st.assistantMessageIndices[st.assistantMessageIndices.length - 1] ?? -1}:${st.assistantMessageIndices.length}`}
            >
            <SubtaskCard
              subtask={st}
              messages={messages}
              displayIndex={si}
              cardIndex={sourceIndex}
              isLinked={linkedSubtaskIndex === sourceIndex}
              onSelectSubtask={() => onSelectSubtask(sourceIndex)}
              onForkFromAction={onForkFromAction}
              onAnalyzeFromAction={onAnalyzeFromAction}
              sessionDirectory={sessionDirectory}
              forkPanelSnapshotBundle={forkPanelSnapshotBundle}
              leadingTreemapSize={leadingTreemapSize}
              selectedActionType={
                selection && selection.kind === 'type' && selection.subtaskIndex === sourceIndex
                  ? selection.actionType
                  : null
              }
              selectedActionKey={
                selection && selection.kind === 'action' && selection.subtaskIndex === sourceIndex
                  ? selection.actionKey
                  : null
              }
              flowHighlightedActionKey={
                selection &&
                selection.kind === 'action' &&
                selection.subtaskIndex === sourceIndex &&
                selection.source === 'treemap'
                  ? selection.actionKey
                  : null
              }
              /**
               * 跨子任务 dim 已取消：treemap / rect 选中只影响命中所在子任务卡片，
               * 其它卡片完全保持正常显示，避免「点一个 rect 整页都暗下去」。
               */
              otherSubtaskHasSelection={false}
              onSelectActionType={
                onSelectActionType
                  ? (type) => onSelectActionType(sourceIndex, type)
                  : undefined
              }
              onSelectAction={
                onSelectAction
                  ? (key) => onSelectAction(sourceIndex, key)
                  : undefined
              }
              onSelectActionFromFlow={
                onSelectAction
                  ? (key) => onSelectAction(sourceIndex, key, 'flow')
                  : undefined
              }
              flowLayoutMode={flowLayoutMode}
              colorBy={colorBy}
              onColorByChange={setColorBy}
              actionTypePaletteId={actionTypePaletteId}
            />
            {/**
             * 仅 leading-treemap 模式下：相邻 treemap 之间画一条向下箭头，提示
             * 子任务从上到下的时序流转。位置对齐 treemap 列水平中点，与卡片 wrapper 内
             * 的 treemap 起点（左侧 0）+ treemap_size/2 重合。
             */}
            {leadingTreemapSize && si < visibleSubtasks.length - 1 ? (
              <div
                aria-hidden
                style={{
                  width: '100%',
                  height: 16,
                  marginTop: -4,
                  marginBottom: -4,
                  pointerEvents: 'none',
                }}
              >
                <svg
                  width={leadingTreemapSize}
                  height={16}
                  style={{ display: 'block' }}
                >
                  <line
                    x1={leadingTreemapSize / 2}
                    y1={0}
                    x2={leadingTreemapSize / 2}
                    y2={11}
                    stroke="#BFBFBF"
                    strokeWidth={1.2}
                  />
                  <polyline
                    points={`${leadingTreemapSize / 2 - 3.5},9 ${leadingTreemapSize / 2},14 ${leadingTreemapSize / 2 + 3.5},9`}
                    fill="none"
                    stroke="#BFBFBF"
                    strokeWidth={1.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            ) : null}
            </Fragment>
          ))
        )}
      </div>
    </div>
  )
}
