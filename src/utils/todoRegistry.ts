import type { OcMessage, OcTodo } from '../types/opencode'
import { isTodoWriteMessage, parseTodowriteTodosFromMessage } from './subtaskGrouping'
import { normalizeTodoContent } from './subtaskLinkage'

/** 会话内稳定 id（含 OpenCode 下发 id 或本地产 uuid） */
export type CanonicalTodo = OcTodo & { id: string }

export interface TodoSnapshot {
  messageIndex: number
  todos: CanonicalTodo[]
}

export interface SessionTodoModel {
  /** messageIndex -> 该条 todowrite 之后的 canonical 列表 */
  canonicalAtMessageIndex: Map<number, CanonicalTodo[]>
  /** 与 API 对齐后的当前列表（全状态） */
  latestActive: CanonicalTodo[]
  /** 曾出现且已完成的 id → 最新快照（用于历史区：仅展示已不在当前列表中的已完成项） */
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
 * 按会话消息时间顺序 + 最终 API 列表，为每条 todo 分配稳定 id，并维护「已完成」归档。
 * - 同一条目多次更新：优先用 API `id`；否则按与上一快照 **content** 相同视为同一条。
 * - 当前列表：`latestActive`
 * - 历史：仅保留 **已完成** 且 **当前 latestActive 中已不存在该 id** 的条目（避免与当前重复）。
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

/** 供 UI：历史区只展示「已完成且已离开当前列表」的条目 */
export function archivedCompletedList(archive: Map<string, CanonicalTodo>): CanonicalTodo[] {
  return [...archive.values()].sort((a, b) => a.content.localeCompare(b.content, 'zh-CN'))
}

/** 供 UI：按 message 顺序的历次快照（含 id） */
export function snapshotsOrdered(model: SessionTodoModel): TodoSnapshot[] {
  const out: TodoSnapshot[] = []
  const indices = [...model.canonicalAtMessageIndex.keys()].sort((a, b) => a - b)
  for (const idx of indices) {
    const t = model.canonicalAtMessageIndex.get(idx)
    if (t && t.length > 0) out.push({ messageIndex: idx, todos: t })
  }
  return out
}

/** 消息时间轴上最后一条 todowrite 对应的快照（视为当前「这一批」） */
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
  /** 本批快照里当前已完成的条数（对照 latestActive + 归档） */
  completed: number
  /** 本批快照总条数 */
  total: number
  /** 是否仍有未完成的本批条目（用于 UI 是否展示 completed/total） */
  ongoing: boolean
}

/**
 * 以**最近一次** todowrite 快照为「一批」，计算这批里已完成/总数，及是否仍在推进。
 * `archivedList` 须与面板历史区一致（通常为 `archivedCompletedList(completedArchive)`）。
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
