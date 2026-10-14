import type { OcMessage } from '../types/opencode'
import type { MemoryWorkerTaskSegment, MemoryWorkerTaskSegmentTab } from '../services/memoryWorkerApi'

export type TaskSegmentStatus = 'pending' | 'extracted'

export type TaskSegmentTab = {
  id: string
  status: TaskSegmentStatus
  fromStartUserMessageId: string
  fromEndAssistantMessageId: string
  toEndAssistantMessageId: string
  turnCount: number
  title?: string
  description?: string
  summary?: string
  taskSwitchRunDir?: string
  pipelineRunDir?: string
  provisional?: boolean
}

export function taskSegmentId(status: TaskSegmentStatus, segment: MemoryWorkerTaskSegment): string {
  return segment.taskId || `${status}:${segment.fromEndAssistantMessageId}:${segment.toEndAssistantMessageId}`
}

export function taskSegmentFromWorker(
  status: TaskSegmentStatus,
  segment: MemoryWorkerTaskSegment,
  meta?: Pick<TaskSegmentTab, 'taskSwitchRunDir' | 'pipelineRunDir'>,
): TaskSegmentTab | null {
  const provisionalPending = status === 'pending' && Boolean(segment.provisional)
  if (!provisionalPending && (!segment.fromStartUserMessageId || !segment.toEndAssistantMessageId)) return null
  return {
    id: taskSegmentId(status, segment),
    status,
    fromStartUserMessageId: segment.fromStartUserMessageId,
    fromEndAssistantMessageId: segment.fromEndAssistantMessageId,
    toEndAssistantMessageId: segment.toEndAssistantMessageId,
    turnCount: segment.turnCount,
    title: segment.title?.trim() || undefined,
    description: segment.description?.trim() || undefined,
    summary: segment.summary?.trim() || undefined,
    provisional: provisionalPending || undefined,
    ...meta,
  }
}

export function taskSegmentTabFromWorkerRecord(tab: MemoryWorkerTaskSegmentTab): TaskSegmentTab | null {
  const status = tab.status === 'extracted' ? 'extracted' : 'pending'
  const segment: MemoryWorkerTaskSegment = {
    taskId: tab.taskId,
    fromStartUserMessageId: tab.fromStartUserMessageId,
    fromEndAssistantMessageId: tab.fromEndAssistantMessageId,
    toEndAssistantMessageId: tab.toEndAssistantMessageId,
    turnCount: tab.turnCount,
    title: tab.title,
    description: tab.description,
    summary: tab.summary,
    provisional: tab.provisional,
  }
  return taskSegmentFromWorker(status, segment, {
    taskSwitchRunDir: tab.taskSwitchRunDir,
    pipelineRunDir: tab.pipelineRunDir,
  })
}

export function taskSegmentTabsFromWorkerBatch(tabs: MemoryWorkerTaskSegmentTab[]): TaskSegmentTab[] {
  const out: TaskSegmentTab[] = []
  for (const tab of tabs) {
    const converted = taskSegmentTabFromWorkerRecord(tab)
    if (converted) out.push(converted)
  }
  return out
}

export function mergeTaskTabFields(prior: TaskSegmentTab, incoming: TaskSegmentTab): TaskSegmentTab {
  const merged: TaskSegmentTab = { ...prior, ...incoming }
  if (!incoming.title?.trim()) merged.title = prior.title
  if (!incoming.description?.trim()) merged.description = prior.description
  if (!incoming.summary?.trim()) merged.summary = prior.summary
  if (!incoming.taskSwitchRunDir?.trim()) merged.taskSwitchRunDir = prior.taskSwitchRunDir
  if (!incoming.pipelineRunDir?.trim()) merged.pipelineRunDir = prior.pipelineRunDir
  return merged
}

export function mergeTaskSegmentTabs(
  existing: TaskSegmentTab[],
  incoming: TaskSegmentTab[],
  options?: { taskSwitched?: boolean },
): TaskSegmentTab[] {
  const byId = new Map(existing.map((tab) => [tab.id, tab]))
  const taskSwitched = options?.taskSwitched ?? false
  for (const tab of incoming) {
    if (tab.status === 'pending') {
      for (const [id, old] of byId) {
        if (old.status !== 'pending') continue
        if (old.provisional || !old.fromStartUserMessageId || !old.toEndAssistantMessageId) {
          byId.delete(id)
          continue
        }
        if (taskSwitched) {
          byId.set(id, { ...old, status: 'extracted' })
        } else {
          byId.delete(id)
        }
      }
    }
    const prior = byId.get(tab.id)
    byId.set(tab.id, prior ? mergeTaskTabFields(prior, tab) : tab)
  }
  return [...byId.values()]
}

export function cloneTaskSegmentTabs(tabs: TaskSegmentTab[]): TaskSegmentTab[] {
  return tabs.map((tab) => ({ ...tab }))
}

function messageIndexById(messages: OcMessage[], messageId: string): number {
  if (!messageId) return -1
  return messages.findIndex((m) => m.info.id === messageId)
}

/** Chronological task tabs (same ordering as App task tab bar). */
export function sortTaskSegmentTabsByMessages(tabs: TaskSegmentTab[], messages: OcMessage[]): TaskSegmentTab[] {
  return [...tabs].sort((a, b) => {
    const ai = messageIndexById(messages, a.fromStartUserMessageId)
    const bi = messageIndexById(messages, b.fromStartUserMessageId)
    if (ai !== bi) return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
    return a.id.localeCompare(b.id)
  })
}

/** Assistant message id for the turn containing `anchorMessageId` (inclusive). */
export function resolveTurnEndAssistantAtOrBefore(messages: OcMessage[], anchorMessageId: string): string | null {
  const anchorIdx = messageIndexById(messages, anchorMessageId)
  if (anchorIdx < 0) return null
  for (let i = anchorIdx; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.info.role === 'assistant') return msg.info.id
  }
  return null
}

function tabStartMessageIndex(tab: TaskSegmentTab, messages: OcMessage[], priorTabs: TaskSegmentTab[]): number {
  const previousEndIndex = priorTabs.reduce((latest, prior) => {
    const idx = messageIndexById(messages, prior.toEndAssistantMessageId)
    return idx >= 0 ? Math.max(latest, idx) : latest
  }, -1)
  const rawStart = messageIndexById(messages, tab.fromStartUserMessageId)
  if (rawStart < 0) return rawStart
  return previousEndIndex >= 0 ? Math.max(rawStart, previousEndIndex + 1) : rawStart
}

function tabEndMessageIndex(tab: TaskSegmentTab, messages: OcMessage[]): number {
  if (tab.status === 'pending' || tab.provisional) return Number.POSITIVE_INFINITY
  return messageIndexById(messages, tab.toEndAssistantMessageId)
}

export type TaskSegmentMessageRange = {
  startIndex: number
  endIndex: number
}

/**
 * Resolve the message index window for a task tab against the live session timeline.
 * Falls back gracefully when fork truncation removed the original tab end marker.
 *
 * `extendToLiveEnd`: keep the chronologically latest tab open through the newest
 * messages so the right-rail trajectory stays live while task-switch is still deciding
 * (and before a new pending tab exists). Pending/provisional tabs always extend.
 */
export function resolveTaskSegmentMessageRange(
  tab: TaskSegmentTab,
  messages: OcMessage[],
  priorTabs: TaskSegmentTab[],
  options?: { extendToLiveEnd?: boolean },
): TaskSegmentMessageRange | null {
  if (messages.length === 0) return null

  const previousEndIndex = priorTabs.reduce((latest, prior) => {
    const idx = messageIndexById(messages, prior.toEndAssistantMessageId)
    return idx >= 0 ? Math.max(latest, idx) : latest
  }, -1)

  const rawStartIndex = messageIndexById(messages, tab.fromStartUserMessageId)
  let startIndex =
    rawStartIndex >= 0
      ? previousEndIndex >= 0
        ? Math.max(rawStartIndex, previousEndIndex + 1)
        : rawStartIndex
      : previousEndIndex >= 0
        ? previousEndIndex + 1
        : 0

  const explicitEndIndex = tab.toEndAssistantMessageId
    ? messageIndexById(messages, tab.toEndAssistantMessageId)
    : -1

  const openEnded =
    tab.status === 'pending' || tab.provisional || Boolean(options?.extendToLiveEnd)

  // New pending / post-fork tabs often activate before any message exists after the
  // previous task end. Treat that as "no window yet" so callers can fall back instead
  // of blanking the right-rail trajectory.
  if (startIndex >= messages.length) return null

  let endIndex: number
  if (openEnded) {
    // Always follow the live timeline — do not clip at a stale toEndAssistantMessageId.
    endIndex = messages.length - 1
  } else if (explicitEndIndex >= 0) {
    endIndex = explicitEndIndex
  } else {
    // Forked / truncated sessions: tab end id may no longer exist in the copied timeline.
    endIndex = messages.length - 1
  }

  if (endIndex < startIndex) return null
  return { startIndex, endIndex }
}

export type TaskSegmentSubtaskLike = {
  assistantMessageIndices?: number[]
}

/**
 * Keep subtasks whose **first** assistant message falls in the tab window.
 * Using the anchor (not `.every`) avoids cards vanishing from every tab when a
 * segment boundary bisects a multi-message subtask after fork / task-switch.
 */
export function filterSubtasksForTaskSegmentRange<T extends { subtask: TaskSegmentSubtaskLike }>(
  items: T[],
  range: TaskSegmentMessageRange,
): T[] {
  const { startIndex, endIndex } = range
  return items.filter(({ subtask }) => {
    const assistantIndices = subtask.assistantMessageIndices ?? []
    if (assistantIndices.length === 0) return false
    const anchor = assistantIndices[0]!
    return anchor >= startIndex && anchor <= endIndex
  })
}

/**
 * Resolve the message window used to render the right-rail trajectory for a task tab.
 * Falls back to the previous tab (or the full timeline) when the active tab has no
 * messages yet — common right after task-switch / fork.
 */
export function resolveVisibleTaskSegmentRange(
  activeTab: TaskSegmentTab,
  tabs: TaskSegmentTab[],
  messages: OcMessage[],
): TaskSegmentMessageRange | null {
  const activeSegmentIndex = tabs.findIndex((tab) => tab.id === activeTab.id)
  const priorTabs = activeSegmentIndex > 0 ? tabs.slice(0, activeSegmentIndex) : []
  const isLatestTab = activeSegmentIndex >= 0 && activeSegmentIndex === tabs.length - 1
  const range = resolveTaskSegmentMessageRange(activeTab, messages, priorTabs, {
    extendToLiveEnd: isLatestTab,
  })
  if (range) return range

  if (!isLatestTab || priorTabs.length === 0) return null

  const prior = priorTabs[priorTabs.length - 1]!
  return resolveTaskSegmentMessageRange(prior, messages, priorTabs.slice(0, -1), {
    extendToLiveEnd: true,
  })
}

/** Drop tabs whose start lies beyond the session, and clamp stale extracted ends after fork. */
export function reconcileTaskTabsWithMessages(tabs: TaskSegmentTab[], messages: OcMessage[]): TaskSegmentTab[] {
  if (tabs.length === 0) return tabs
  const sorted = sortTaskSegmentTabsByMessages(tabs, messages)
  const kept: TaskSegmentTab[] = []

  for (const tab of sorted) {
    const range = resolveTaskSegmentMessageRange(tab, messages, kept)
    if (!range) continue

    const endInMessages = tab.toEndAssistantMessageId
      ? messageIndexById(messages, tab.toEndAssistantMessageId)
      : -1
    if (tab.status === 'extracted' && tab.toEndAssistantMessageId && endInMessages < 0) {
      const turnEnd = resolveTurnEndAssistantAtOrBefore(messages, messages[range.endIndex]!.info.id)
      if (!turnEnd) continue
      kept.push(
        rebuildTaskTabIdentity(
          tab,
          turnEnd,
          countAssistantTurnEnds(messages, range.startIndex, range.endIndex),
          'pending',
        ),
      )
      continue
    }

    kept.push(tab)
  }

  return kept
}

function countAssistantTurnEnds(messages: OcMessage[], startIdx: number, endIdx: number): number {
  if (startIdx < 0 || endIdx < startIdx) return 0
  let count = 0
  for (let i = startIdx; i <= endIdx; i++) {
    if (messages[i]?.info.role !== 'assistant') continue
    const next = messages[i + 1]
    if (!next || next.info.role === 'user') count++
  }
  return count
}

function rebuildTaskTabIdentity(
  tab: TaskSegmentTab,
  toEndAssistantMessageId: string,
  turnCount: number,
  status: TaskSegmentStatus,
): TaskSegmentTab {
  const fromEnd = tab.fromEndAssistantMessageId
  const taskId = fromEnd && toEndAssistantMessageId ? `task:${fromEnd}:${toEndAssistantMessageId}` : tab.id
  const segment: MemoryWorkerTaskSegment = {
    taskId,
    fromStartUserMessageId: tab.fromStartUserMessageId,
    fromEndAssistantMessageId: fromEnd,
    toEndAssistantMessageId,
    turnCount,
    title: tab.title,
    description: tab.description,
    summary: tab.summary,
    provisional: status === 'pending' ? tab.provisional : undefined,
  }
  return {
    ...tab,
    status,
    toEndAssistantMessageId,
    turnCount,
    provisional: status === 'pending' ? tab.provisional : undefined,
    id: taskSegmentId(status, segment),
  }
}

function truncateTaskTabAtForkAnchor(
  tab: TaskSegmentTab,
  messages: OcMessage[],
  priorTabs: TaskSegmentTab[],
  forkAnchorMessageId: string,
): TaskSegmentTab {
  const turnEnd = resolveTurnEndAssistantAtOrBefore(messages, forkAnchorMessageId)
  if (!turnEnd) return tab
  const originalEnd = tab.toEndAssistantMessageId
  if (turnEnd === originalEnd) return tab

  const startIdx = tabStartMessageIndex(tab, messages, priorTabs)
  const endIdx = messageIndexById(messages, turnEnd)
  const turnCount = countAssistantTurnEnds(messages, startIdx, endIdx)
  const truncated = turnEnd !== originalEnd && tab.status === 'extracted' ? 'pending' : tab.status
  return rebuildTaskTabIdentity(tab, turnEnd, Math.max(turnCount, 1), truncated)
}

export type ForkTaskTabFilterResult = {
  tabs: TaskSegmentTab[]
  activeTabId: string | undefined
}

/**
 * Keep task tabs up to the fork origin tab (inclusive), drop later tabs, and truncate the
 * origin tab's trajectory at the fork anchor. Skill / segment metadata on kept tabs is preserved.
 */
export function filterTaskTabsForFork(
  tabs: TaskSegmentTab[],
  messages: OcMessage[],
  forkAnchorMessageId: string,
  options?: { activeTabId?: string },
): ForkTaskTabFilterResult {
  if (tabs.length === 0 || !forkAnchorMessageId) {
    return { tabs: [], activeTabId: undefined }
  }

  const sorted = sortTaskSegmentTabsByMessages(tabs, messages)
  const anchorIdx = messageIndexById(messages, forkAnchorMessageId)

  let forkTabIndex = options?.activeTabId
    ? sorted.findIndex((tab) => tab.id === options.activeTabId)
    : -1

  if (forkTabIndex < 0 && anchorIdx >= 0) {
    forkTabIndex = sorted.findIndex((tab, index) => {
      const start = tabStartMessageIndex(tab, messages, sorted.slice(0, index))
      const end = tabEndMessageIndex(tab, messages)
      if (start < 0) return false
      return anchorIdx >= start && anchorIdx <= end
    })
  }

  if (forkTabIndex < 0) forkTabIndex = sorted.length - 1

  const kept = sorted.slice(0, forkTabIndex + 1)
  if (kept.length === 0) return { tabs: [], activeTabId: undefined }

  const prior = kept.slice(0, -1)
  const forkTab = truncateTaskTabAtForkAnchor(kept[kept.length - 1]!, messages, prior, forkAnchorMessageId)
  const resultTabs = [...prior, forkTab]

  return {
    tabs: resultTabs,
    activeTabId: forkTab.id,
  }
}
