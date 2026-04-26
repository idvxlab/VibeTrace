import { Fragment, type RefObject, useState } from 'react'
import type { MappedAction, OcMessage } from '../types/opencode'
import type { AssistantSubtask } from '../utils/subtaskGrouping'
import type { ForkFromActionContext, ForkPanelSnapshotBundle } from '../utils/forkPanelSnapshot'
import SubtaskCard from './SubtaskCard'
import ActionTypeColorLegend from './ActionTypeColorLegend'
import {
  type ActionTypePaletteId,
  DEFAULT_ACTION_TYPE_PALETTE_ID,
} from '../styles/actionTypePalettes'

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
  flowLayoutMode?: 'timeline' | 'packing'
}

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
          overflowY: 'auto',
          fontSize: 11,
          color: '#333',
          lineHeight: 1.45,
        }}
      >
        {visibleSubtasks.length === 0 ? (
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
