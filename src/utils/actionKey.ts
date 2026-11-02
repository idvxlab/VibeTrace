import type { MappedAction } from '../types/opencode'

/**
 * Stable identity for flow/treemap sync: `MappedAction` has no id, so compose message + part + call + band row.
 */
export function actionKey(act: MappedAction & { row: number }): string {
  return `${act.messageID ?? '_'}|${act.partId ?? '_'}|${act.callID ?? '_'}|${act.row}`
}

/** First segment from `actionKey()` — parent transcript message id when encoded. */
export function actionKeyMessageId(key: string): string | null {
  const raw = key.split('|')[0] ?? ''
  return raw !== '_' && raw.length > 0 ? raw : null
}
