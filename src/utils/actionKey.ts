import type { MappedAction } from '../types/opencode'

/**
 * 一个 action 的稳定唯一键（用于 treemap ↔ ActionFlow ↔ App 状态联动）。
 * MappedAction 没有显式 id，用 messageID + partId + callID + row 组合可在单个 flow 内全局唯一。
 */
export function actionKey(act: MappedAction & { row: number }): string {
  return `${act.messageID ?? '_'}|${act.partId ?? '_'}|${act.callID ?? '_'}|${act.row}`
}
