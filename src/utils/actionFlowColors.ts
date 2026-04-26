import * as d3 from 'd3'
import type { ActionStatus, MappedAction } from '../types/opencode'
import { actionFlowPalette } from '../styles/actionFlowPalette'
import {
  type ActionTypePaletteId,
  DEFAULT_ACTION_TYPE_PALETTE_ID,
  getActionTypeTriad,
} from '../styles/actionTypePalettes'

const LONG_RUNNING_MS = 60_000

/** 从 ActionFlowVisualization 抽出，treemap 内 mini block 共用同一套着色 */
export function statusColors(status: ActionStatus): { fill: string; stroke: string; icon: string } {
  const { completed, running, red, pending } = actionFlowPalette
  switch (status) {
    case 'running':
      return { fill: running.fill, stroke: running.stroke, icon: running.icon }
    case 'pending':
      return { fill: pending.fill, stroke: pending.stroke, icon: pending.icon }
    case 'error':
      return { fill: red.fill, stroke: red.stroke, icon: red.icon }
    default:
      return { fill: completed.fill, stroke: completed.stroke, icon: completed.icon }
  }
}

export function effectiveStatusColors(
  status: ActionStatus,
  durationMs: number
): { fill: string; stroke: string; icon: string; isLongRunning: boolean } {
  const base = statusColors(status)
  const isLongRunning = (status === 'running' || status === 'pending') && durationMs >= LONG_RUNNING_MS
  if (!isLongRunning) return { ...base, isLongRunning: false }
  return {
    fill: '#FFE9E9',
    stroke: '#FF7A7A',
    icon: '#E24F4F',
    isLongRunning: true,
  }
}

export function tokenColor(
  scale: d3.ScaleSequential<string>,
  tok: number
): { fill: string; stroke: string } {
  const c = scale(tok)
  const base = d3.color(c)
  return {
    fill: base?.brighter(0.35).formatHex() ?? '#E3F2FD',
    stroke: base?.darker(0.9).formatHex() ?? '#0D47A1',
  }
}

export function buildTokenColorScale(actions: MappedAction[]): d3.ScaleSequential<string> {
  const maxTok = Math.max(1, ...actions.map((a) => a.tokenEstimate))
  return d3.scaleSequential(d3.interpolateBlues).domain([0, maxTok])
}

/**
 * 与 ActionFlowVisualization 中 rect 着色一致：
 * - ghost / ghostError：灰 / 红
 * - type 模式：`typePaletteId` 对应调色盘
 * - 否则 status / tokens（子会话不再单独紫色）
 */
export function resolveActionBlockColors(
  act: MappedAction,
  colorMode: 'status' | 'tokens' | 'type',
  tokenScale: d3.ScaleSequential<string>,
  typePaletteId: ActionTypePaletteId = DEFAULT_ACTION_TYPE_PALETTE_ID
): { fill: string; stroke: string; iconFill: string } {
  const isGhost = act.forkGhost === true

  /**
   * 状态优先级最高：error / pending 永远覆盖 tokens / type / ghost。
   * 这样在高风险状态下不会被“语义色”稀释。
   */
  if (act.status === 'error') {
    const err = statusColors('error')
    return { fill: err.fill, stroke: err.stroke, iconFill: err.icon }
  }
  if (act.status === 'pending') {
    const p = statusColors('pending')
    return { fill: p.fill, stroke: p.stroke, iconFill: p.icon }
  }
  if (isGhost) {
    return { fill: '#E8E8E8', stroke: '#CFCFCF', iconFill: '#A0A0A0' }
  }
  if (colorMode === 'type') {
    const tp = getActionTypeTriad(typePaletteId, act.actionType)
    return { fill: tp.fill, stroke: tp.stroke, iconFill: tp.accent }
  }
  if (colorMode === 'status') {
    const sc = effectiveStatusColors(act.status, act.durationMs)
    return { fill: sc.fill, stroke: sc.stroke, iconFill: sc.icon }
  }
  const tc = tokenColor(tokenScale, act.tokenEstimate)
  return { fill: tc.fill, stroke: tc.stroke, iconFill: actionFlowPalette.completed.icon }
}
