import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import SubtaskActionTypeTreemap from './SubtaskActionTypeTreemap'
import {
  type ActionTypePaletteId,
} from '../styles/actionTypePalettes'
import { getMessages } from '../services/opencodeApi'
import { actionKey } from '../utils/actionKey'

const fontSans =
  "'PingFang SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif"

/** 子任务卡片最小高度；内容（如分叉可视化）变高时卡片随内容增高 */
const CARD_MIN_HEIGHT = 220
const LONG_RUNNING_MS = 60_000

interface SubtaskCardProps {
  subtask: AssistantSubtask
  messages: OcMessage[]
  displayIndex: number
  /** DOM 定位索引：用于连线/滚动，需与 App 中 linkedSubtaskIndex 使用同一坐标系 */
  cardIndex?: number
  isLinked?: boolean
  onSelectSubtask?: () => void
  onForkFromAction?: (action: MappedAction & { row: number }, ctx: ForkFromActionContext) => void
  onAnalyzeFromAction?: (action: MappedAction & { row: number }) => void
  /** 与 OpenCode 多目录一致，拉取子会话消息时必带 */
  sessionDirectory?: string
  /** Forked session: local read-only snapshot for comparison (not in model context) */
  forkPanelSnapshotBundle?: ForkPanelSnapshotBundle | null
  /**
   * 全屏 packing view 模式：传入正数则在卡片左侧前置一个方形 action-type treemap，
   * 颜色与右侧 ActionFlow 内每个 block 1:1 一致（共享 colorBy / durationMode 状态）。
   */
  leadingTreemapSize?: number
  /** 当前选中的 actionType（来自 App 的联动状态）；同 type 在 ActionFlow 加亮，其他暗化 */
  selectedActionType?: string | null
  /** 当前选中的单个 action key；优先级高于 selectedActionType */
  selectedActionKey?: string | null
  /** 仅用于 ActionFlow 的 action-level 筛选（区分 treemap 点击与普通点击） */
  flowHighlightedActionKey?: string | null
  /** 选中位于其他子任务卡片时，本卡所有 action 应整体 dim */
  otherSubtaskHasSelection?: boolean
  /** treemap cell 点击：传 null 取消选中 */
  onSelectActionType?: (actionType: string | null) => void
  /** treemap mini-block 或 ActionFlow rect 单击：传 null 取消选中 */
  onSelectAction?: (actionKey: string | null) => void
  /** ActionFlow rect 单击：仅同步 treemap 选中，不触发 flow 筛选 */
  onSelectActionFromFlow?: (actionKey: string | null) => void
  /** 由父级统一控制：timeline / packing */
  flowLayoutMode?: 'timeline' | 'packing'
  /** 全局共享颜色模式（由上层子任务面板控制） */
  colorBy: ColorByMode
  onColorByChange: (mode: ColorByMode) => void
  /** 全局共享 type 调色盘（由上层子任务面板控制） */
  actionTypePaletteId: ActionTypePaletteId
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
  leadingTreemapSize,
  selectedActionType = null,
  selectedActionKey = null,
  flowHighlightedActionKey = null,
  otherSubtaskHasSelection = false,
  onSelectActionType,
  onSelectAction,
  onSelectActionFromFlow,
  flowLayoutMode = 'timeline',
  colorBy,
  onColorByChange,
  actionTypePaletteId,
}: SubtaskCardProps) {
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [actionsDurationOn, setActionsDurationOn] = useState(false)
  const [filterMode, setFilterMode] = useState<FilterMode>('duration')
  /** 仅用于 DOM 锚点（fork/scroll 等需要时取 outer wrapper） */
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [childBranchActions, setChildBranchActions] = useState<(MappedAction & { row: number })[]>([])
  /** task 子会话原文，用于 Changes 合并统计 write/edit 路径 */
  const [childBranchMessages, setChildBranchMessages] = useState<OcMessage[]>([])

  const m = useMemo(
    () =>
      buildSubtaskCardMetrics(subtask, messages, displayIndex, {
        nowMs: nowTick,
        additionalMessages: childBranchMessages,
      }),
    [subtask, messages, displayIndex, nowTick, childBranchMessages],
  )

  /** 本子任务段内的 assistant 消息（顺序与全局 timeline 一致） */
  const segmentMessages = useMemo((): OcMessage[] => {
    return subtask.assistantMessageIndices
      .map(i => messages[i])
      .filter((msg): msg is OcMessage => msg != null)
  }, [subtask.assistantMessageIndices, messages])

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
  /** 并行子会话共享同一 band；非并行仍按唯一 childSessionID 递增。 */
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
            `子会话 branch · ${d.callID.slice(0, 12)}`,
            sessionDirectory,
          )
          const branchOpts = {
            branchChildSessionID: d.childSessionID,
            parentTaskCallID: d.callID,
            anchorSortTime: d.anchorSortTime,
            /** 按 session 固定分配进程带：第 1 个唯一子 session=1，第 2 个=2 ... */
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
  /** 仅当用户把阈值高于数据下界时才触发 dim；停在默认下界时与未筛选一致 */
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

  /** 与 `flowActions` 中 `partId` 查找一致：父段消息 + 子会话拉取消息 */
  const tooltipLookupMessages = useMemo(
    () => mergeMessagesForActionTooltipLookup(segmentMessages, childBranchMessages),
    [segmentMessages, childBranchMessages],
  )

  /**
   * Fork 后：在同一 SVG 内合并「fork 前共享前缀」+「锚点后旧轨迹（灰幽灵）」+「新分支」。
   *
   * 关键设计：fork 前的 action 是新 session 上下文的天然组成部分（OpenCode 的 fork 把消息
   * 复制到了新 session），它们就在 `flowActions` 里。所以 pre-fork + 新分支都直接复用
   * `flowActions` 的对象 —— 这样 treemap、debug panel、tooltip、selection 联动等所有
   * 下游逻辑都能正确认识它们；只有 anchor 之后的「旧分支假设轨迹」（ghost）才需要从
   * snapshot 拿（因为新 session 里没有这一段）。
   *
   * 兜底：如果新 session 没回填 pre-fork 消息（极端情况），退化为完全用 snapshot 当 pre-fork。
   */
  const forkMergedFlow = useMemo(() => {
    if (!forkPanelSnapshotBundle || forkPanelSnapshotBundle.version !== 2) return null
    const b = forkPanelSnapshotBundle
    if (b.forkOriginSubtaskId !== subtask.subtask_id && b.forkOriginDisplayIndex !== displayIndex) {
      return null
    }
    const anchorMessageId = b.forkAnchorMessageId
    const anchorPartId = b.forkAnchorPartId
    const matchAnchor = (a: MappedAction & { row: number }) =>
      a.messageID === anchorMessageId && (anchorPartId ? a.partId === anchorPartId : true)

    const oldActions = b.snapshot.flowActions
    const oldAnchorIdx = oldActions.findIndex(matchAnchor)
    /** 锚点必须能在 snapshot 中定位；找不到时不进入合并模式 */
    if (oldAnchorIdx < 0) return null

    /** 优先在当前 session 里定位锚点 —— 拿到的就是 flowActions 自己的对象，
     *  treemap / 选中联动 / 闪烁高亮 都共享同一份引用。 */
    const currentAnchorIdx = flowActions.findIndex(matchAnchor)

    let preForkAndAnchor: (MappedAction & { row: number })[]
    let postAnchorCurrent: (MappedAction & { row: number })[]
    if (currentAnchorIdx >= 0) {
      preForkAndAnchor = flowActions.slice(0, currentAnchorIdx + 1)
      postAnchorCurrent = flowActions.slice(currentAnchorIdx + 1)
    } else {
      /** 兜底：新 session 没回填 fork 前的消息 —— 用 snapshot 的前缀，
       *  整个 flowActions 都视为新分支 */
      preForkAndAnchor = oldActions.slice(0, oldAnchorIdx + 1)
      postAnchorCurrent = flowActions
    }

    const anchorActionKey = actionKey(preForkAndAnchor[preForkAndAnchor.length - 1]!)
    /** 当前 session 语义：fork 前 + 当前分支（用于 treemap / 统计 / 选中联动） */
    const sessionActions = [...preForkAndAnchor, ...postAnchorCurrent].sort(
      (x, y) => x.sortTime - y.sortTime,
    )

    /** 锚点之后的旧轨迹：snapshot 数据，打 forkGhost 标 */
    const ghostSuffix = oldActions
      .slice(oldAnchorIdx + 1)
      .map((a) => ({ ...a, forkGhost: true }))

    /** 新分支：当前 session 锚点之后的部分，打 forkCompareRow=2 标 */
    const newBranch = postAnchorCurrent.map((a) => ({ ...a, forkCompareRow: 2 as const }))

    const merged = [...preForkAndAnchor, ...ghostSuffix, ...newBranch].sort(
      (x, y) => x.sortTime - y.sortTime,
    )
    const mergedTooltips = [...b.snapshot.tooltipMessages, ...tooltipLookupMessages]
    return { merged, mergedTooltips, anchorActionKey, sessionActions }
  }, [forkPanelSnapshotBundle, subtask.subtask_id, displayIndex, flowActions, tooltipLookupMessages])
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
     * 2s 一次 tick：每次 tick 会让 parentFlowActions / flowActions 引用刷新，
     * ActionFlowVisualization 的 d3 effect 整张 SVG 重建一次（视觉上是一次闪烁）。
     * 1Hz 太密（生成时连续闪），2s 在「duration 实时感」与「不刺眼」之间更平衡。
     */
    const id = window.setInterval(() => setNowTick(Date.now()), 2000)
    return () => window.clearInterval(id)
  }, [hasActiveRunningAction])

  const durationLabel = formatDurationMs(m.durationMs)
  const changesLabel = String(m.mutatedFileCount)
  /** 无进行中 action 时才显示流程终点黄点（避免子任务一开始就出现「收尾」） */
  const showFlowEndNode = !hasActiveRunningAction && flowActions.length > 0
  const showLeadingTreemap = typeof leadingTreemapSize === 'number' && leadingTreemapSize > 0

  /**
   * 稳化 flowEndSummary 引用 —— inline 字面量每次 render 都是新对象，会让
   * ActionFlowVisualization 第一个 useLayoutEffect 误以为「数据变了」从而
   * `selectAll('*').remove()` 重建整个 SVG，造成点击 / nowTick 时所有 rect 闪烁。
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
    }),
    [
      m.readFilesCount,
      m.readFilePaths,
      m.globMatchFileCount,
      m.webSearchCallCount,
      m.webSearchQueries,
      m.mutatedFileCount,
      m.mutatedFilePaths,
    ],
  )

  /** 同样原因稳化：onForkFromAction 包装的箭头函数 */
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
      <h3
        style={{
          margin: 0,
          fontWeight: 600,
          fontSize: 13,
          lineHeight: '18px',
          color: '#2B2B2B',
          flexShrink: 0,
        }}
      >
        {m.title}
      </h3>

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
           * Fork 比对模式：把灰色幽灵 + 新分支合并到一个 ActionFlowVisualization；
           * 否则正常使用当前 session 的 flowActions。
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
              highlightedActionKey={flowHighlightedActionKey}
              dimAll={otherSubtaskHasSelection}
              onSelectAction={onSelectActionFromFlow}
              forkAnchorActionKey={forkAnchor}
              layoutMode={flowLayoutMode}
              onForkFromAction={handleForkFromActionWrapped}
              onAnalyzeFromAction={onAnalyzeFromAction}
              showFlowEndNode={flowLayoutMode === 'timeline' ? showFlowEndNode : false}
              flowEndSummary={flowEndSummary}
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
        <MetricBox label="Agent Msg" value={String(m.llmCallCount)} />
        <MetricBox label="Changes" value={changesLabel} />
        <MetricBox label="Time" value={durationLabel} alert={hasLongRunningAction} />
        <MetricBox label="Total Tokens" value={String(m.tokensSegmentSum)} />
        <MetricBox label="Cost" value={formatSubtaskCostDisplay(m)} />
      </div>
    </>
  )

  /** 卡片本体样式（不含 treemap），leading 与 non-leading 共用 */
  const cardInnerStyle: React.CSSProperties = {
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

  if (!showLeadingTreemap) {
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

  /** Leading 模式：treemap 是 card 的 sibling，跟卡片 y 轴居中对齐，挂在 card 框外 */
  const treemapSide = leadingTreemapSize as number
  return (
    <div
      ref={cardRef}
      data-subtask-card-index={cardIndex ?? displayIndex}
      style={{
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        marginBottom: 8,
        width: '100%',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: treemapSide,
          height: treemapSide,
          flexShrink: 0,
          alignSelf: 'center',
        }}
      >
        <SubtaskActionTypeTreemap
          actions={forkMergedFlow?.sessionActions ?? flowActions}
          colorMode={colorBy}
          actionTypePaletteId={actionTypePaletteId}
          width={treemapSide}
          height={treemapSide}
          tooltipMessages={forkMergedFlow?.mergedTooltips ?? tooltipLookupMessages}
          selectedType={selectedActionType}
          selectedActionKey={selectedActionKey}
          dimAll={otherSubtaskHasSelection}
          onSelectType={onSelectActionType}
          onSelectAction={onSelectAction}
        />
      </div>
      <div
        onClick={() => onSelectSubtask?.()}
        style={{ ...cardInnerStyle, flex: 1, minWidth: 0 }}
      >
        {bodyContent}
      </div>
    </div>
  )
}
