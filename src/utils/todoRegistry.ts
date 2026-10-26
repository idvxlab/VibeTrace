import type { OcMessage, OcTodo } from '../types/opencode'
import { isTodoWriteMessage, parseTodowriteTodosFromMessage } from './subtaskGrouping'
import { normalizeTodoContent } from './subtaskLinkage'

/** Stable id within the session (OpenCode-provided id or locally generated uuid) */
export type CanonicalTodo = OcTodo & { id: string }

export interface TodoSnapshot {
  messageIndex: number
  todos: CanonicalTodo[]
}

export interface SessionTodoModel {
  /** messageIndex -> canonical list after that todowrite */
  canonicalAtMessageIndex: Map<number, CanonicalTodo[]>
  /** Current list aligned with API (all statuses) */
  latestActive: CanonicalTodo[]
  /** id of completed items that appeared before → latest snapshot (history: only items no longer in current list) */
  completedArchive: Map<string, CanonicalTodo>
}

function assignStableIds(prev: CanonicalTodo[] | null, raw: OcTodo[]): CanonicalTodo[] {
  const used = new Set<string>()
  const out: CanonicalTodo[] = []

  for (const r of raw) {
    const apiId = r.id?.trim()
    if (apiId) {
      used.add(apiId)
      out.push({ ...r, id: apiId })
      continue
    }
    const c = normalizeTodoContent(r.content)
    const match = prev?.find(p => !used.has(p.id) && normalizeTodoContent(p.content) === c)
    if (match) {
      used.add(match.id)
      out.push({ ...r, id: match.id })
    } else {
      const id = crypto.randomUUID()
      used.add(id)
      out.push({ ...r, id })
    }
  }
  return out
}

function mergeCompletedArchive(archive: Map<string, CanonicalTodo>, list: CanonicalTodo[]): void {
  for (const t of list) {
    if (t.status === 'completed') {
      archive.set(t.id, { ...t })
    }
  }
}

/**
 * Assign stable ids per message order + final API list, and maintain a completed archive.
 * - Repeated updates to one item: prefer API `id`; else same **content** as previous snapshot = same item.
 * - Current list: `latestActive`
 * - History: only **completed** items whose id is **no longer in latestActive** (avoid duplicating current).
 */
export function buildSessionTodoModel(
  messages: OcMessage[],
  apiTodos: OcTodo[],
  snapshotMap: Record<string, OcTodo[]>
): SessionTodoModel {
  const canonicalAtMessageIndex = new Map<number, CanonicalTodo[]>()
  const completedArchive = new Map<string, CanonicalTodo>()
  let prev: CanonicalTodo[] | null = null

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (!isTodoWriteMessage(msg)) continue

    let raw: OcTodo[] | null = parseTodowriteTodosFromMessage(msg)
    if (!raw || raw.length === 0) {
      const cached = snapshotMap[String(i)]
      if (cached && cached.length > 0) raw = cached.map(t => ({ ...t }))
    }
    if (!raw || raw.length === 0) continue

    const canonical = assignStableIds(prev, raw)
    canonicalAtMessageIndex.set(i, canonical)
    mergeCompletedArchive(completedArchive, canonical)
    prev = canonical
  }

  const latestActive =
    apiTodos.length > 0 ? assignStableIds(prev, apiTodos) : prev ?? []

  mergeCompletedArchive(completedArchive, latestActive)

  const activeIds = new Set(latestActive.map(t => t.id))
  for (const id of activeIds) {
    completedArchive.delete(id)
  }

  return {
    canonicalAtMessageIndex,
    latestActive,
    completedArchive,
  }
}

/** For UI: current todo list in API order */
export function latestActiveForMessagePanel(model: SessionTodoModel): CanonicalTodo[] {
  return model.latestActive
}

/** For UI: history shows only completed items that left the current list */
export function archivedCompletedList(archive: Map<string, CanonicalTodo>): CanonicalTodo[] {
  return [...archive.values()].sort((a, b) => a.content.localeCompare(b.content, 'en'))
}

/** For UI: ordered snapshots by message (with ids) */
export function snapshotsOrdered(model: SessionTodoModel): TodoSnapshot[] {
  const out: TodoSnapshot[] = []
  const indices = [...model.canonicalAtMessageIndex.keys()].sort((a, b) => a - b)
  for (const idx of indices) {
    const t = model.canonicalAtMessageIndex.get(idx)
    if (t && t.length > 0) out.push({ messageIndex: idx, todos: t })
  }
  return out
}

/** Snapshot for the last todowrite on the message timeline (treated as the current batch) */
export function latestTodowriteSnapshotTodos(model: SessionTodoModel): CanonicalTodo[] | null {
  let bestIdx = -1
  let best: CanonicalTodo[] | null = null
  for (const [idx, list] of model.canonicalAtMessageIndex) {
    if (list.length > 0 && idx > bestIdx) {
      bestIdx = idx
      best = list
    }
  }
  return best
}

export interface LatestTodowriteBatchProgress {
  /** Completed count in this batch snapshot (vs latestActive + archive) */
  completed: number
  /** Total items in this batch snapshot */
  total: number
  /** Whether this batch still has incomplete items (controls UI completed/total display) */
  ongoing: boolean
}

/**
 * Treat the **most recent** todowrite snapshot as one batch; compute completed/total and whether work is ongoing.
 * `archivedList` must match the panel history (usually `archivedCompletedList(completedArchive)`).
 */
export function getLatestTodowriteBatchProgress(
  model: SessionTodoModel,
  archivedList: CanonicalTodo[]
): LatestTodowriteBatchProgress | null {
  const batch = latestTodowriteSnapshotTodos(model)
  if (!batch?.length) return null

  const activeById = new Map(model.latestActive.map(t => [t.id, t]))
  const archivedIds = new Set(archivedList.map(t => t.id))

  let completed = 0
  let ongoing = false

  for (const row of batch) {
    const cur = activeById.get(row.id)
    if (cur) {
      if (cur.status === 'completed') completed++
      else ongoing = true
    } else if (archivedIds.has(row.id)) {
      completed++
    } else {
      ongoing = true
    }
  }

  return { completed, total: batch.length, ongoing }
}
