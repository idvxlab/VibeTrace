import type { MemoryWorkerErrorDiagnosis } from '../services/memoryWorkerApi'

/** Higher rank = prefer keeping / overwriting with this entry. */
export function panelAnalysisEntryRank(item: MemoryWorkerErrorDiagnosis): number {
  const completed = item.completedAt ? Date.parse(String(item.completedAt)) : Number.NaN
  if (Number.isFinite(completed)) return completed
  if (item.status === 'ok') return 1
  if (item.status === 'running') return 0
  return -1
}

export function shouldReplacePanelAnalysis(
  existing: MemoryWorkerErrorDiagnosis | undefined,
  incoming: MemoryWorkerErrorDiagnosis,
): boolean {
  if (!existing) return true
  return panelAnalysisEntryRank(incoming) >= panelAnalysisEntryRank(existing)
}

export function mergePanelAnalysisItemsIntoBucket(
  bucket: Record<string, MemoryWorkerErrorDiagnosis>,
  items: MemoryWorkerErrorDiagnosis[],
): { bucket: Record<string, MemoryWorkerErrorDiagnosis>; changed: boolean } {
  const next = { ...bucket }
  let changed = false
  for (const item of items) {
    const subtaskId = item.subtaskId?.trim()
    if (!subtaskId) continue
    if (!shouldReplacePanelAnalysis(next[subtaskId], item)) continue
    next[subtaskId] = item
    changed = true
  }
  return { bucket: next, changed }
}
