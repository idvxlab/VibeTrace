import {
  Fragment,
  type RefObject,
  type WheelEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Tooltip } from 'react-tooltip'
import type {
  MappedAction,
  OcMessage,
  OcMessagePart,
  OcPendingPermissionRequest,
  OcPermissionTraceEvent,
  OcSessionCompactionEvent,
} from '../types/opencode'
import type { AssistantSubtask } from '../utils/subtaskGrouping'
import type { ForkFromActionContext, ForkPanelSnapshotBundle } from '../utils/forkPanelSnapshot'
import SubtaskCard from './SubtaskCard'
import ActionTypeColorLegend from './ActionTypeColorLegend'
import {
  type ActionTypePaletteId,
  DEFAULT_ACTION_TYPE_PALETTE_ID,
  getActionTypeTriad,
} from '../styles/actionTypePalettes'
import { buildMappedActionsFromMessages, collectTaskChildDescriptors, isSubagentSeededUserRequest } from '../utils/actionMapping'
import { actionKey } from '../utils/actionKey'
import { getMessages } from '../services/opencodeApi'
import {
  distillTaskFeedback,
  fetchTaskSkillDetail,
  fetchTaskSkills,
  saveTaskSkillMd,
  type MemoryWorkerErrorDiagnosis,
  type SkillDistillHistoryEntry,
  type TaskSkillDetailResult,
  type TaskSkillRecord,
} from '../services/memoryWorkerApi'
import {
  buildCompactMappedActionTooltipHtml,
  mergeMessagesForActionTooltipLookup,
} from '../utils/actionTooltipMapping'
import { stripHarnessGuidanceForDisplay } from '../config/harnessGuidance'
import { experimentTelemetry } from '../experiment/telemetry'

/** Skill row in the session-scoped Skill Panel (may come from any task tab). */
type SessionSkillRecord = TaskSkillRecord & { taskId: string }

function skillRecordMarker(skill: Pick<TaskSkillRecord, 'skillPath' | 'skillName' | 'feedbackRunDir'>): string {
  return String(skill.skillPath || skill.skillName || skill.feedbackRunDir || '').trim()
}

export type SubtaskTaskTab = {
  id: string
  status: 'pending' | 'extracted'
  turnCount: number
  title?: string
  description?: string
  summary?: string
  fromStartUserMessageId?: string
  fromEndAssistantMessageId?: string
  toEndAssistantMessageId?: string
}

/** Mirrors `formatDurationMs` in ActionFlowVisualization for summary tooltips */
function formatSummaryTooltipDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '—'
  const sec = durationMs / 1000
  if (sec < 0.01) return '<0.01s'
  return `${sec.toFixed(2)}s`
}

function summarizeTaskText(text: string, maxLen = 120): string {
  const clean = stripHarnessGuidanceForDisplay(text).replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  if (clean.length <= maxLen) return clean
  return `${clean.slice(0, maxLen - 1).trimEnd()}…`
}

function userMessageText(message: OcMessage | undefined): string {
  if (!message) return ''
  return message.parts
    .filter((part): part is Extract<OcMessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function firstUserMessageIndex(subtask: AssistantSubtask): number | null {
  const indices = subtask.userMessageIndices ?? []
  if (indices.length === 0) return null
  return Math.min(...indices)
}

function historyEntrySourceLabel(entry: SkillDistillHistoryEntry): string | null {
  if (entry.channel === 'feedback' || entry.source === 'feedback_distill') return 'Feedback'
  if (entry.channel === 'manual' || entry.source === 'manual_edit') return 'Manual'
  return null
}

function operationBadgeStyle(operation: string | undefined): { bg: string; color: string; border: string } {
  const op = String(operation || 'UPDATE').toUpperCase()
  if (op === 'CREATE') return { bg: '#ECFDF3', color: '#027A48', border: '#ABEFC6' }
  if (op === 'DELETE') return { bg: '#FEF3F2', color: '#B42318', border: '#FECDCA' }
  if (op === 'NONE') return { bg: '#F2F4F7', color: '#475467', border: '#E4E7EC' }
  if (op === 'MANUAL_EDIT') return { bg: '#F4F3FF', color: '#5925DC', border: '#D9D6FE' }
  return { bg: '#EFF8FF', color: '#175CD3', border: '#B2DDFF' }
}

function formatHistoryTimestamp(value: string | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function extractHistoryAnchorIndex(entry: SkillDistillHistoryEntry): number | null {
  const anchors = entry.traceAnchors ?? []
  for (const anchor of anchors) {
    if (typeof anchor.subtaskIndex === 'number') return anchor.subtaskIndex
    if (typeof anchor.panelIndex === 'number') return anchor.panelIndex
  }
  return null
}

function historyEntryBodyText(entry: SkillDistillHistoryEntry): string {
  const rationale = entry.rationale?.trim() || ''
  const summary = entry.summary?.trim() || ''
  if (rationale && summary && rationale !== summary) return rationale
  return rationale || summary || 'Skill change record'
}

function _historyTextsOverlap(a: string, b: string): boolean {
  const left = a.trim().toLowerCase()
  const right = b.trim().toLowerCase()
  if (!left || !right) return false
  return left === right || left.includes(right) || right.includes(left)
}

function historyEntryUserComment(entry: SkillDistillHistoryEntry, bodyText: string): string {
  if (entry.channel !== 'feedback' && entry.source !== 'feedback_distill') return ''
  const comment = entry.userComment?.trim() || ''
  if (!comment || _historyTextsOverlap(comment, bodyText)) return ''
  return comment
}

function historyEntryTraceQuote(entry: SkillDistillHistoryEntry, bodyText: string): string {
  if (entry.channel === 'feedback' || entry.source === 'feedback_distill') return ''
  for (const anchor of entry.traceAnchors ?? []) {
    const quote = anchor.quote_or_summary ?? anchor.summary
    if (typeof quote === 'string' && quote.trim() && !_historyTextsOverlap(quote, bodyText)) {
      return quote.trim()
    }
  }
  return ''
}

function historyEntryChangePaths(entry: SkillDistillHistoryEntry): string[] {
  const paths = (entry.changes ?? [])
    .map((change) => change.path?.trim())
    .filter((path): path is string => Boolean(path))
  const meaningful = paths.filter((path) => path.toLowerCase() !== 'skill.md')
  return meaningful.length > 0 ? meaningful.slice(0, 3) : []
}

function historyEntryNavigateLabel(entry: SkillDistillHistoryEntry, anchorIndex: number | null): string | null {
  if (anchorIndex !== null) return `Panel #${anchorIndex + 1}`
  if (entry.taskId) return 'View task'
  return null
}

function formatFeedbackScopeLabel(selectedIndices: number[], totalPanelCount: number): string {
  if (selectedIndices.length === 0) return ''
  if (totalPanelCount > 0 && selectedIndices.length === totalPanelCount) {
    return totalPanelCount === 1 ? 'Panel #1' : `All ${totalPanelCount} panels`
  }
  if (selectedIndices.length === 1) {
    return `Panel #${selectedIndices[0]! + 1}`
  }
  return `Panel ${selectedIndices.map((idx) => `#${idx + 1}`).join(', ')}`
}

interface SubtaskDebugPanelProps {
  messages: OcMessage[]
  visibleSubtasks: Array<{ subtask: AssistantSubtask; sourceIndex: number }>
  linkedSubtaskIndex: number | null
  onSelectSubtask: (index: number) => void
  onForkFromAction?: (action: MappedAction & { row: number }, ctx: ForkFromActionContext) => void
  onAnalyzeFromAction?: (action: MappedAction & { row: number }) => void
  listScrollRef?: RefObject<HTMLDivElement | null>
  sessionDirectory?: string
  /** Saved fork-before snapshot for the forked session (local). */
  forkPanelSnapshotBundle?: ForkPanelSnapshotBundle | null
  /** Links selection from ActionFlow rects. */
  selection?: { subtaskIndex: number; actionKey: string } | null
  /** ActionFlow rect click → action-level selection. */
  onSelectAction?: (subtaskIndex: number, actionKey: string | null) => void
  /** Layout mode toggled by the subtask panel header. */
  flowLayoutMode?: 'timeline' | 'summary'
  taskTabs?: SubtaskTaskTab[]
  activeTaskTabId?: string
  onSelectTaskTab?: (id: string) => void
  sessionId?: string
  errorDiagnosisBySubtaskId?: Record<string, MemoryWorkerErrorDiagnosis>
  /** Fired when a panel trajectory seals — triggers independent Trace summary / error diagnosis. */
  onPanelSealed?: (subtaskId: string) => void
  /** First time a subtask card scrolls into view (≥35% visible). */
  onPanelBecameVisible?: (subtaskId: string) => void
  /** Live OpenCode permission ask for this session (SSE / hydrate). */
  pendingPermission?: OcPendingPermissionRequest | null
  /** Permission asks kept on the trajectory after Allow/Reject. */
  permissionTraces?: OcPermissionTraceEvent[]
  /** Live SSE compaction marker for this session. */
  recentCompaction?: OcSessionCompactionEvent | null
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
  selection = null,
  onSelectAction,
  flowLayoutMode = 'timeline',
  taskTabs = [],
  activeTaskTabId,
  onSelectTaskTab,
  sessionId,
  errorDiagnosisBySubtaskId = {},
  onPanelSealed,
  onPanelBecameVisible,
  pendingPermission = null,
  permissionTraces = [],
  recentCompaction = null,
}: SubtaskDebugPanelProps) {
  const summaryTooltipSafeId = useId().replace(/:/g, '')
  const summaryTooltipId = `subtask-summary-tip-${summaryTooltipSafeId}`
  const [tooltipMounted, setTooltipMounted] = useState(false)
  const pendingSummaryTipRef = useRef(false)
  const pendingSummarySubtaskIdRef = useRef<string | null>(null)
  const [colorBy, setColorBy] = useState<'tokens' | 'type'>('type')
  const [legendExpanded, setLegendExpanded] = useState(true)
  const [skillsByTaskId, setSkillsByTaskId] = useState<Record<string, TaskSkillRecord[]>>({})
  const [skillStatusByTaskId, setSkillStatusByTaskId] = useState<Record<string, string>>({})
  const [skillDiscoveredCountByTaskId, setSkillDiscoveredCountByTaskId] = useState<Record<string, number>>({})
  const [skillLoadingByTaskId, setSkillLoadingByTaskId] = useState<Record<string, boolean>>({})
  const [skillErrorByTaskId, setSkillErrorByTaskId] = useState<Record<string, string>>({})
  const [skillComment, setSkillComment] = useState('')
  const [feedbackMode, setFeedbackMode] = useState(false)
  const [selectedSkillRecord, setSelectedSkillRecord] = useState<SessionSkillRecord | null>(null)
  const [selectedSkillDetail, setSelectedSkillDetail] = useState<TaskSkillDetailResult | null>(null)
  const [skillDetailLoading, setSkillDetailLoading] = useState(false)
  const [skillDetailError, setSkillDetailError] = useState('')
  const [skillMdDraft, setSkillMdDraft] = useState('')
  const [skillMdEditing, setSkillMdEditing] = useState(false)
  const [skillMdDirty, setSkillMdDirty] = useState(false)
  const [skillMdSaving, setSkillMdSaving] = useState(false)
  const [skillMdSaveError, setSkillMdSaveError] = useState('')
  const [copiedSkillPath, setCopiedSkillPath] = useState(false)
  const [selectedFeedbackSubtaskIndices, setSelectedFeedbackSubtaskIndices] = useState<number[]>([])
  const [panelFeedbackByIndex, setPanelFeedbackByIndex] = useState<Record<number, string>>({})
  const [editingFeedbackSubtaskIndex, setEditingFeedbackSubtaskIndex] = useState<number | null>(null)
  const [draftPanelFeedback, setDraftPanelFeedback] = useState('')
  const actionTypePaletteId: ActionTypePaletteId = DEFAULT_ACTION_TYPE_PALETTE_ID
  const [childSessionMessages, setChildSessionMessages] = useState<Record<string, OcMessage[]>>({})
  const summaryViewportRef = useRef<HTMLDivElement | null>(null)
  /**
   * Follow the newest panel while generating; pause when the user scrolls up or
   * selects a historical trajectory (same stick-to-bottom pattern as MessagePanel).
   */
  const stickTrajectoryToBottomRef = useRef(true)
  const TRAJECTORY_NEAR_BOTTOM_PX = 120

  const setStickTrajectoryToBottom = (pinned: boolean) => {
    stickTrajectoryToBottomRef.current = pinned
  }

  const scrollTrajectoryToBottom = (behavior: ScrollBehavior = 'auto') => {
    if (flowLayoutMode === 'summary') return
    const el = listScrollRef?.current
    if (!el) return
    if (behavior === 'smooth') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }

  const updateStickTrajectoryFromScroll = () => {
    const el = listScrollRef?.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setStickTrajectoryToBottom(distanceFromBottom <= TRAJECTORY_NEAR_BOTTOM_PX)
  }

  /** Intentional upward scroll immediately releases auto-follow (more reliable than scrollTop during streaming). */
  const handleTrajectoryListWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (e.deltaY < 0) setStickTrajectoryToBottom(false)
  }

  /** Selecting a historical card pauses follow so App's scrollIntoView is not yanked back to the latest. */
  useEffect(() => {
    if (linkedSubtaskIndex === null || visibleSubtasks.length === 0) return
    const latestSourceIndex = visibleSubtasks[visibleSubtasks.length - 1]?.sourceIndex
    if (latestSourceIndex !== undefined && linkedSubtaskIndex !== latestSourceIndex) {
      setStickTrajectoryToBottom(false)
    }
  }, [linkedSubtaskIndex, visibleSubtasks])

  /** New session: resume auto-follow until the user scrolls up again. */
  useEffect(() => {
    setStickTrajectoryToBottom(true)
  }, [sessionId])

  useEffect(() => {
    if (!onPanelBecameVisible) return
    const root = flowLayoutMode === 'summary' ? summaryViewportRef.current : listScrollRef?.current
    if (!root) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || entry.intersectionRatio < 0.35) continue
          const id = (entry.target as HTMLElement).dataset.subtaskPanelId
          if (id) onPanelBecameVisible(id)
        }
      },
      { root: flowLayoutMode === 'summary' ? null : root, threshold: [0, 0.35, 0.5] },
    )

    const nodes = root.querySelectorAll('[data-subtask-panel-id]')
    nodes.forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [visibleSubtasks, flowLayoutMode, onPanelBecameVisible, listScrollRef])

  /** New panels while pinned to bottom: keep the newest card in view. */
  const prevVisibleCountRef = useRef(visibleSubtasks.length)
  useEffect(() => {
    if (flowLayoutMode === 'summary') return
    const prev = prevVisibleCountRef.current
    const next = visibleSubtasks.length
    prevVisibleCountRef.current = next
    if (next <= prev) return
    if (!stickTrajectoryToBottomRef.current) return
    requestAnimationFrame(() => {
      if (!stickTrajectoryToBottomRef.current) return
      scrollTrajectoryToBottom('smooth')
    })
  }, [visibleSubtasks.length, flowLayoutMode, listScrollRef])

  /** Keep following while pinned as cards grow (streaming tools / duration ticks). */
  useEffect(() => {
    if (flowLayoutMode === 'summary') return
    if (!stickTrajectoryToBottomRef.current || visibleSubtasks.length === 0) return
    requestAnimationFrame(() => {
      if (!stickTrajectoryToBottomRef.current) return
      scrollTrajectoryToBottom()
    })
  }, [visibleSubtasks, messages, flowLayoutMode, listScrollRef])

  useEffect(() => {
    if (flowLayoutMode === 'summary') return
    const el = listScrollRef?.current
    if (!el || typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => {
      if (!stickTrajectoryToBottomRef.current) return
      scrollTrajectoryToBottom()
    })
    observer.observe(el, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [flowLayoutMode, listScrollRef, sessionId])
  const [summaryViewportSize, setSummaryViewportSize] = useState({ width: 0, height: 0 })
  const displayTaskTabs =
    taskTabs.length > 0
      ? taskTabs
      : [
          {
            id: 'task-1-live',
            status: 'pending' as const,
            turnCount: 0,
          },
        ]
  const activeDisplayTask =
    displayTaskTabs.find((tab) => tab.id === activeTaskTabId) ?? displayTaskTabs[displayTaskTabs.length - 1] ?? null
  const activeDisplayTaskIndex = activeDisplayTask
    ? Math.max(0, displayTaskTabs.findIndex((tab) => tab.id === activeDisplayTask.id))
    : 0
  const activeDisplayTaskLabel = `Task ${activeDisplayTaskIndex + 1}`
  const activeTaskId = activeDisplayTask?.id ?? ''
  const sessionTaskIds = useMemo(
    () => displayTaskTabs.map((tab) => tab.id).filter((id) => Boolean(id) && id !== 'task-1-live'),
    [displayTaskTabs],
  )
  const sessionTaskIdsKey = sessionTaskIds.join('|')
  const sessionSkills = useMemo<SessionSkillRecord[]>(() => {
    const out: SessionSkillRecord[] = []
    const seen = new Set<string>()
    for (const taskId of sessionTaskIds) {
      for (const skill of skillsByTaskId[taskId] ?? []) {
        const marker = skillRecordMarker(skill)
        if (marker && seen.has(marker)) continue
        if (marker) seen.add(marker)
        out.push({ ...skill, taskId })
      }
    }
    return out.sort((a, b) => {
      const at = Date.parse(a.createdAt || '') || 0
      const bt = Date.parse(b.createdAt || '') || 0
      return bt - at
    })
  }, [sessionTaskIds, skillsByTaskId])
  const sessionSkillLoading = sessionTaskIds.some((taskId) => Boolean(skillLoadingByTaskId[taskId]))
  const sessionSkillStatus = useMemo(() => {
    if (sessionTaskIds.length === 0) return 'none'
    const statuses = sessionTaskIds.map((taskId) => skillStatusByTaskId[taskId] ?? 'none')
    if (statuses.some((s) => s === 'distilling') || sessionSkillLoading) return 'distilling'
    if (sessionSkills.length > 0 || statuses.some((s) => s === 'ready')) return 'ready'
    if (statuses.some((s) => s === 'error')) return 'error'
    return 'none'
  }, [sessionTaskIds, skillStatusByTaskId, sessionSkillLoading, sessionSkills.length])
  const sessionSkillDiscoveredCount = sessionTaskIds.reduce(
    (sum, taskId) => sum + (skillDiscoveredCountByTaskId[taskId] ?? 0),
    0,
  )
  const sessionSkillError = sessionTaskIds
    .map((taskId) => skillErrorByTaskId[taskId])
    .find((err) => Boolean(err))
  const canShowSkillDock = Boolean(
    activeDisplayTask && (activeDisplayTask.turnCount > 0 || visibleSubtasks.length > 0),
  )
  const activeTaskTitle = useMemo(() => {
    if (activeDisplayTask?.title?.trim()) return activeDisplayTask.title.trim()
    const startId = activeDisplayTask?.fromStartUserMessageId
    if (!startId) return ''
    const message = messages.find((m) => m.info.id === startId)
    return summarizeTaskText(userMessageText(message), 80)
  }, [activeDisplayTask, messages])
  const activeTaskDescription = useMemo(() => {
    return activeDisplayTask?.description?.trim() || ''
  }, [activeDisplayTask])
  const showTaskBrief = Boolean(activeTaskTitle || activeTaskDescription)

  useEffect(() => {
    setTooltipMounted(true)
  }, [])

  useEffect(() => {
    setFeedbackMode(false)
    setSelectedFeedbackSubtaskIndices([])
    setPanelFeedbackByIndex({})
    setEditingFeedbackSubtaskIndex(null)
    setDraftPanelFeedback('')
    setSkillComment('')
  }, [activeTaskId])

  useEffect(() => {
    setSelectedSkillRecord(null)
    setSelectedSkillDetail(null)
    setSkillDetailError('')
    setCopiedSkillPath(false)
    setSkillsByTaskId({})
    setSkillStatusByTaskId({})
    setSkillDiscoveredCountByTaskId({})
    setSkillLoadingByTaskId({})
    setSkillErrorByTaskId({})
  }, [sessionId])

  useEffect(() => {
    if (!canShowSkillDock || !sessionId || sessionTaskIds.length === 0) return
    let cancelled = false
    const taskIds = [...sessionTaskIds]
    for (const taskId of taskIds) {
      setSkillLoadingByTaskId((prev) => ({ ...prev, [taskId]: true }))
      setSkillErrorByTaskId((prev) => ({ ...prev, [taskId]: '' }))
    }
    void Promise.all(
      taskIds.map(async (taskId) => {
        try {
          const result = await fetchTaskSkills(sessionId, taskId, sessionDirectory)
          return { taskId, result, error: null as string | null }
        } catch (err: unknown) {
          return {
            taskId,
            result: null,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }),
    ).then((entries) => {
      if (cancelled) return
      setSkillsByTaskId((prev) => {
        const next = { ...prev }
        for (const entry of entries) {
          if (entry.result) next[entry.taskId] = entry.result.skills ?? []
        }
        return next
      })
      setSkillStatusByTaskId((prev) => {
        const next = { ...prev }
        for (const entry of entries) {
          next[entry.taskId] = entry.result?.status || (entry.error ? 'error' : 'none')
        }
        return next
      })
      setSkillDiscoveredCountByTaskId((prev) => {
        const next = { ...prev }
        for (const entry of entries) {
          next[entry.taskId] = entry.result?.discoveredCount ?? 0
        }
        return next
      })
      setSkillErrorByTaskId((prev) => {
        const next = { ...prev }
        for (const entry of entries) {
          next[entry.taskId] = entry.error || ''
        }
        return next
      })
      setSkillLoadingByTaskId((prev) => {
        const next = { ...prev }
        for (const entry of entries) {
          next[entry.taskId] = false
        }
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [canShowSkillDock, sessionDirectory, sessionId, sessionTaskIdsKey])

  const anySkillDistilling = sessionTaskIds.some((taskId) => skillStatusByTaskId[taskId] === 'distilling')

  // Poll while distilling (and briefly after new task tabs appear) so users see skills without switching tabs.
  useEffect(() => {
    if (!canShowSkillDock || !sessionId || sessionTaskIds.length === 0) return

    let cancelled = false
    let attempts = 0
    const taskIds = [...sessionTaskIds]
    const startedAt = Date.now()
    const GRACE_MS = 45_000
    const MAX_MS = 4 * 60_000

    const applyEntries = (
      entries: Array<{
        taskId: string
        result: Awaited<ReturnType<typeof fetchTaskSkills>> | null
        error: string | null
      }>,
    ) => {
      setSkillsByTaskId((prev) => {
        const next = { ...prev }
        for (const entry of entries) {
          if (entry.result) next[entry.taskId] = entry.result.skills ?? []
        }
        return next
      })
      setSkillStatusByTaskId((prev) => {
        const next = { ...prev }
        for (const entry of entries) {
          next[entry.taskId] = entry.result?.status || (entry.error ? 'error' : prev[entry.taskId] || 'none')
        }
        return next
      })
      setSkillDiscoveredCountByTaskId((prev) => {
        const next = { ...prev }
        for (const entry of entries) {
          if (entry.result) next[entry.taskId] = entry.result.discoveredCount ?? 0
        }
        return next
      })
      setSkillErrorByTaskId((prev) => {
        const next = { ...prev }
        for (const entry of entries) {
          next[entry.taskId] = entry.error || ''
        }
        return next
      })
      return entries.map((entry) => entry.result?.status || (entry.error ? 'error' : 'none'))
    }

    const pollOnce = async () => {
      const entries = await Promise.all(
        taskIds.map(async (taskId) => {
          try {
            const result = await fetchTaskSkills(sessionId, taskId, sessionDirectory)
            return { taskId, result, error: null as string | null }
          } catch (err: unknown) {
            return {
              taskId,
              result: null,
              error: err instanceof Error ? err.message : String(err),
            }
          }
        }),
      )
      if (cancelled) return [] as string[]
      return applyEntries(entries)
    }

    const timer = window.setInterval(() => {
      void (async () => {
        if (cancelled) return
        attempts += 1
        const elapsed = Date.now() - startedAt
        if (elapsed > MAX_MS) {
          window.clearInterval(timer)
          return
        }
        const statuses = await pollOnce()
        if (cancelled) return
        const stillDistilling = statuses.some((s) => s === 'distilling')
        const inGrace = elapsed < GRACE_MS
        if (!stillDistilling && !inGrace) {
          window.clearInterval(timer)
        }
        void attempts
      })()
    }, 20_000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [anySkillDistilling, canShowSkillDock, sessionDirectory, sessionId, sessionTaskIdsKey])

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
          segmentMessages,
        }
      }),
    [visibleSubtasks, messages],
  )

  useEffect(() => {
    if (flowLayoutMode !== 'summary') return
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

  const summaryRows = summarySegments.map(
    ({ sourceIndex, rowIndex, subtaskId, parentActions, childDescriptors, segmentMessages }) => {
      const childActions = childDescriptors.flatMap((desc) => {
        const msgs = childSessionMessages[desc.childSessionID] ?? []
        return buildMappedActionsFromMessages(msgs).map((a, i) => ({
          ...a,
          /** Place after parent task for readable ordering within the subtask. */
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
        segmentMessages,
        childDescriptors,
      }
    },
  )
  /**
   * Lexicographic sort by action-type sequence (no section headers).
   * Rows whose timeline starts with UserRequest are placed first so “user turn → …”
   * groups sit at the top; then group by first differing action type, then length / rowIndex.
   */
  const summaryRowsSorted = [...summaryRows].sort((a, b) => {
    const startsUr = (sig: string[]) => sig[0] === 'UserRequest'
    const pri = (sig: string[]) => (startsUr(sig) ? 0 : 1)
    const cmpPri = pri(a.sequenceSignature) - pri(b.sequenceSignature)
    if (cmpPri !== 0) return cmpPri

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
  const selectedFeedbackIndexSet = useMemo(
    () => new Set(selectedFeedbackSubtaskIndices),
    [selectedFeedbackSubtaskIndices],
  )
  const selectedFeedbackPanels = useMemo(
    () =>
      selectedFeedbackSubtaskIndices
        .map((sourceIndex) => {
          const visibleIndex = visibleSubtasks.findIndex((item) => item.sourceIndex === sourceIndex)
          const entry = visibleIndex >= 0 ? visibleSubtasks[visibleIndex] : null
          return entry
            ? {
                sourceIndex,
                visibleIndex,
                subtask: entry.subtask,
                comment: panelFeedbackByIndex[sourceIndex]?.trim() ?? '',
              }
            : null
        })
        .filter((item): item is NonNullable<typeof item> => item !== null),
    [selectedFeedbackSubtaskIndices, visibleSubtasks, panelFeedbackByIndex],
  )
  const feedbackScopeLabel = useMemo(
    () => formatFeedbackScopeLabel(selectedFeedbackSubtaskIndices, visibleSubtasks.length),
    [selectedFeedbackSubtaskIndices, visibleSubtasks.length],
  )
  const panelsWithPanelComments = useMemo(
    () => selectedFeedbackPanels.filter((panel) => Boolean(panel.comment)),
    [selectedFeedbackPanels],
  )
  const compactFeedbackMessagePart = (part: OcMessage['parts'][number]) => {
    if (part.type === 'text') {
      return { type: part.type, id: part.id, text: part.text.slice(0, 2400) }
    }
    if (part.type === 'reasoning') {
      return { type: part.type, id: part.id, text: part.text.slice(0, 1200) }
    }
    if (part.type === 'tool') {
      const output =
        typeof part.state.output === 'string'
          ? part.state.output.slice(0, 1200)
          : part.state.output == null
          ? undefined
          : JSON.stringify(part.state.output).slice(0, 1200)
      return {
        type: part.type,
        id: part.id,
        callID: part.callID,
        tool: part.tool,
        status: part.state.status,
        title: part.state.title,
        input: part.state.input,
        output,
        error: part.state.error,
        time: part.state.time,
      }
    }
    if (part.type === 'text-file') {
      return { type: part.type, id: part.id, path: part.path, content: part.content.slice(0, 1200) }
    }
    if (part.type === 'compaction') {
      return { type: part.type, id: part.id, text: part.text?.slice(0, 1200) }
    }
    return { type: part.type, id: part.id }
  }
  const buildFeedbackPanelTrace = (sourceIndex: number) => {
    const visibleIndex = visibleSubtasks.findIndex((item) => item.sourceIndex === sourceIndex)
    const entry = visibleIndex >= 0 ? visibleSubtasks[visibleIndex] : null
    if (!entry) return null
    const sortedMessageIndices = [
      ...(entry.subtask.userMessageIndices ?? []),
      ...entry.subtask.assistantMessageIndices,
    ].sort((a, b) => a - b)
    const row = summaryRows.find((item) => item.sourceIndex === sourceIndex)
    return {
      traceKind: 'feedback',
      schemaVersion: 'feedback.panel-trace.v1',
      subtaskIndex: sourceIndex,
      visibleIndex,
      subtaskId: entry.subtask.subtask_id,
      messageIndices: sortedMessageIndices,
      userMessageIndices: entry.subtask.userMessageIndices ?? [],
      assistantMessageIndices: entry.subtask.assistantMessageIndices,
      messageIds: sortedMessageIndices
        .map((idx) => messages[idx]?.info.id)
        .filter((id): id is string => Boolean(id)),
      messages: sortedMessageIndices
        .map((idx) => {
          const msg = messages[idx]
          if (!msg) return null
          return {
            index: idx,
            id: msg.info.id,
            role: msg.info.role,
            sessionID: msg.info.sessionID,
            parentID: msg.info.parentID,
            content: msg.info.content?.slice(0, 2400),
            time: msg.info.time,
            model: msg.info.model,
            tokens: msg.info.tokens,
            cost: msg.info.cost,
            finish: msg.info.finish,
            parts: msg.parts.map(compactFeedbackMessagePart),
          }
        })
        .filter((msg): msg is NonNullable<typeof msg> => msg !== null),
      actions: (row?.actions ?? []).map((action) => ({
        actionKey: actionKey(action),
        actionType: action.actionType,
        status: action.status,
        durationMs: action.durationMs,
        tokenEstimate: action.tokenEstimate,
        messageId: action.messageID,
        partId: action.partId,
        callId: action.callID,
        childSessionId: action.childSessionID,
        detail: action.detail,
      })),
    }
  }
  const toggleFeedbackPanel = (sourceIndex: number) => {
    setSelectedFeedbackSubtaskIndices((prev) =>
      prev.includes(sourceIndex)
        ? prev.filter((idx) => idx !== sourceIndex)
        : [...prev, sourceIndex].sort((a, b) => a - b),
    )
  }
  const enterFeedbackMode = () => {
    setFeedbackMode(true)
    setSelectedFeedbackSubtaskIndices(visibleSubtasks.map(({ sourceIndex }) => sourceIndex))
  }
  const hasSelectedFeedbackPanels = selectedFeedbackPanels.length > 0
  const hasFeedbackComment = Boolean(
    skillComment.trim() || panelsWithPanelComments.length > 0,
  )
  const canDistillFeedback = hasSelectedFeedbackPanels && hasFeedbackComment
  const feedbackInputPlaceholder = !hasSelectedFeedbackPanels
    ? 'Please select at least one panel'
    : 'Describe your feedback on the selected execution trace — what worked, what failed, or what should change'
  const distillButtonDisabled =
    sessionSkillLoading || !sessionId || !activeTaskId || !canDistillFeedback
  const selectAllFeedbackPanels = () => {
    setSelectedFeedbackSubtaskIndices(visibleSubtasks.map(({ sourceIndex }) => sourceIndex))
  }
  const deselectAllFeedbackPanels = () => {
    setSelectedFeedbackSubtaskIndices([])
  }
  const openPanelFeedbackEditor = (sourceIndex: number) => {
    setFeedbackMode(true)
    setSelectedFeedbackSubtaskIndices((prev) =>
      prev.includes(sourceIndex) ? prev : [...prev, sourceIndex].sort((a, b) => a - b),
    )
    setEditingFeedbackSubtaskIndex(sourceIndex)
    setDraftPanelFeedback(panelFeedbackByIndex[sourceIndex] ?? '')
  }
  const summaryLayout = useMemo(() => {
    const DEFAULT_BLOCK_W = 28
    const DEFAULT_BLOCK_H = 36
    const rowCount = Math.max(1, summaryRowsSorted.length)
    const maxActionCount = Math.max(1, ...summaryRowsSorted.map((r) => r.actions.length))
    const availableW = Math.max(1, summaryViewportSize.width)
    const availableH = Math.max(1, summaryViewportSize.height)
    const blockWidth = Math.max(2, Math.floor(Math.min(DEFAULT_BLOCK_W, availableW / maxActionCount)))
    const blockHeight = Math.max(2, Math.floor(Math.min(DEFAULT_BLOCK_H, availableH / rowCount)))
    return { blockWidth, blockHeight }
  }, [summaryRowsSorted, summaryViewportSize.width, summaryViewportSize.height])

  const summaryPanel = (
    <>
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
          <span style={{ color: '#AAA', fontSize: 11 }}>No subtasks</span>
        ) : (
          summaryRowsSorted.map((row) => {
            const tooltipMessages = mergeMessagesForActionTooltipLookup(
              row.segmentMessages,
              row.childDescriptors.flatMap((d) => childSessionMessages[d.childSessionID] ?? []),
            )
            return (
              <div key={`${row.subtaskId}:${row.sourceIndex}:${row.rowIndex}`} data-subtask-panel-id={row.subtaskId}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0,
                    margin: 0,
                    height: summaryLayout.blockHeight,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0,
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      height: summaryLayout.blockHeight,
                      flex: 1,
                      minWidth: 0,
                      padding: 0,
                    }}
                  >
                    {row.actions.length === 0 ? (
                      <span style={{ color: '#B0B0B0', fontSize: 10 }}>No actions</span>
                    ) : (
                      row.actions.map((action) => {
                        const paletteTriad = getActionTypeTriad(actionTypePaletteId, action.actionType)
                        const summaryFill =
                          action.actionType === 'UserRequest'
                            ? isSubagentSeededUserRequest(action)
                              ? getActionTypeTriad(actionTypePaletteId, 'Subagent').fill
                              : getActionTypeTriad(actionTypePaletteId, 'UserRequest').stroke
                            : paletteTriad.fill
                        const tipHtml = buildCompactMappedActionTooltipHtml(
                          action,
                          tooltipMessages,
                          formatSummaryTooltipDuration,
                        )
                        return (
                          <span
                            key={actionKey(action)}
                            data-tooltip-id={summaryTooltipId}
                            data-tooltip-html={tipHtml}
                            data-tooltip-place="top"
                            data-vt-tip="action"
                            onMouseEnter={() => {
                              pendingSummaryTipRef.current = true
                              pendingSummarySubtaskIdRef.current = row.subtaskId
                              experimentTelemetry.onPanelView(row.subtaskId, sessionId, 'tooltip.summary')
                            }}
                            style={{
                              width: summaryLayout.blockWidth,
                              height: summaryLayout.blockHeight,
                              borderRadius: 0,
                              flexShrink: 0,
                              background: summaryFill,
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
      {tooltipMounted && (
        <Tooltip
          id={summaryTooltipId}
          anchorSelect={`[data-tooltip-id="${summaryTooltipId}"]`}
          className="action-flow-react-tooltip"
          variant="light"
          positionStrategy="fixed"
          delayShow={150}
          delayHide={220}
          opacity={1}
          clickable
          globalCloseEvents={{ scroll: false, resize: true, escape: true }}
          arrowColor="#f8fafc"
          afterShow={() => {
            experimentTelemetry.enterPanelFocus('tooltip')
            if (pendingSummaryTipRef.current) {
              experimentTelemetry.onActionTooltipShow(
                sessionId,
                'summary',
                pendingSummarySubtaskIdRef.current || undefined,
              )
            }
          }}
          afterHide={() => {
            experimentTelemetry.leavePanelFocus('tooltip', 'trajectory')
          }}
        />
      )}
    </>
  )

  const handleDistillSkill = () => {
    if (!activeDisplayTask || !sessionId || !activeTaskId) return
    if (selectedFeedbackPanels.length === 0) return
    const comment = skillComment.trim()
    if (!comment && !selectedFeedbackPanels.some((panel) => panel.comment)) return
    const taskId = activeTaskId
    const panelFeedback = selectedFeedbackPanels.map((panel) => ({
      subtaskIndex: panel.sourceIndex,
      visibleIndex: panel.visibleIndex,
      subtaskId: panel.subtask.subtask_id,
      comment: panel.comment,
      trace: buildFeedbackPanelTrace(panel.sourceIndex),
    }))
    const selectedAnchor =
      selectedFeedbackSubtaskIndices.length > 0
        ? {
            subtaskIndex: selectedFeedbackSubtaskIndices[0],
            actionKey:
              selection && selectedFeedbackSubtaskIndices.includes(selection.subtaskIndex)
                ? selection.actionKey
                : null,
          }
        : selection
        ? {
            subtaskIndex: selection.subtaskIndex,
            actionKey: selection.actionKey,
          }
        : null
    const requestPayload = {
      sessionId,
      taskId,
      directory: sessionDirectory,
      parentSessionID: sessionId,
      taskSegment: {
        taskId,
        fromStartUserMessageId: activeDisplayTask.fromStartUserMessageId,
        fromEndAssistantMessageId: activeDisplayTask.fromEndAssistantMessageId,
        toEndAssistantMessageId: activeDisplayTask.toEndAssistantMessageId,
        turnCount: activeDisplayTask.turnCount,
      },
      selectedAnchor,
      comment,
      feedbackContext: {
        schemaVersion: 'feedback.distill-request.v1',
        traceKind: 'feedback',
        analyzerIntent: 'distill_skill_from_user_feedback',
        taskLabel: activeDisplayTaskLabel,
        overallComment: comment,
        selectedPanels: panelFeedback,
      },
    }
    console.info('[VibeTrace][task-feedback-distill payload]', JSON.stringify(requestPayload, null, 2))
    setSkillLoadingByTaskId((prev) => ({ ...prev, [taskId]: true }))
    setSkillStatusByTaskId((prev) => ({ ...prev, [taskId]: 'distilling' }))
    setSkillErrorByTaskId((prev) => ({ ...prev, [taskId]: '' }))
    void distillTaskFeedback(requestPayload)
      .then((result) => {
        setSkillsByTaskId((prev) => ({ ...prev, [taskId]: result.skills ?? (result.skill ? [result.skill] : []) }))
        setSkillStatusByTaskId((prev) => ({ ...prev, [taskId]: result.status || 'ready' }))
        setSkillDiscoveredCountByTaskId((prev) => ({ ...prev, [taskId]: result.discoveredCount ?? prev[taskId] ?? 0 }))
        experimentTelemetry.onSkillDistill(
          sessionId,
          result.skill?.skillName || result.skills?.[0]?.skillName,
        )
      })
      .catch((err: unknown) => {
        setSkillStatusByTaskId((prev) => ({ ...prev, [taskId]: 'error' }))
        setSkillErrorByTaskId((prev) => ({
          ...prev,
          [taskId]: err instanceof Error ? err.message : String(err),
        }))
      })
      .finally(() => {
        setSkillLoadingByTaskId((prev) => ({ ...prev, [taskId]: false }))
      })
    setSkillComment('')
    setFeedbackMode(false)
    setSelectedFeedbackSubtaskIndices([])
    setPanelFeedbackByIndex({})
    setEditingFeedbackSubtaskIndex(null)
    setDraftPanelFeedback('')
  }


  const openSkillDetail = (skill: SessionSkillRecord) => {
    if (!sessionId || !skill.taskId) return
    const skillKey = skill.skillPath || skill.skillName || skill.feedbackRunDir || ''
    experimentTelemetry.onSkillPanelClick(sessionId, skillKey || undefined)
    setSelectedSkillRecord(skill)
    setSelectedSkillDetail(null)
    setSkillDetailError('')
    setSkillMdDraft('')
    setSkillMdEditing(false)
    setSkillMdDirty(false)
    setSkillMdSaveError('')
    setCopiedSkillPath(false)
    if (!skillKey) {
      setSkillDetailError('Skill record is missing a readable key.')
      return
    }
    setSkillDetailLoading(true)
    void fetchTaskSkillDetail(sessionId, skill.taskId, skillKey)
      .then((result) => {
        setSelectedSkillDetail(result)
        setSkillMdDraft(result.skillMd || '')
        setSkillDetailError(result.skillReadError || '')
      })
      .catch((err: unknown) => {
        setSkillDetailError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setSkillDetailLoading(false)
      })
  }

  const closeSkillDetail = () => {
    setSelectedSkillRecord(null)
    setSelectedSkillDetail(null)
    setSkillDetailError('')
    setSkillMdDraft('')
    setSkillMdEditing(false)
    setSkillMdDirty(false)
    setSkillMdSaveError('')
    setCopiedSkillPath(false)
  }

  const enterSkillMdEdit = () => {
    if (skillDetailLoading) return
    setSkillMdDraft(selectedSkillDetail?.skillMd || '')
    setSkillMdEditing(true)
    setSkillMdDirty(false)
    setSkillMdSaveError('')
  }

  const cancelSkillMdEdit = () => {
    setSkillMdDraft(selectedSkillDetail?.skillMd || '')
    setSkillMdEditing(false)
    setSkillMdDirty(false)
    setSkillMdSaveError('')
  }

  const saveSkillMdDraft = () => {
    const skillPath = selectedSkillRecord?.skillPath || ''
    const skillTaskId = selectedSkillRecord?.taskId || ''
    const skillKey =
      selectedSkillRecord?.skillPath ||
      selectedSkillRecord?.skillName ||
      selectedSkillRecord?.feedbackRunDir ||
      ''
    if (!skillPath || !skillMdDraft.trim() || !sessionId || !skillTaskId || !skillKey) return
    setSkillMdSaving(true)
    setSkillMdSaveError('')
    void saveTaskSkillMd({
      skillPath,
      content: skillMdDraft,
      sessionId,
      taskId: skillTaskId,
    })
      .then(() =>
        fetchTaskSkillDetail(sessionId, skillTaskId, skillKey).then((result) => {
          setSelectedSkillDetail(result)
          setSkillMdDraft(result.skillMd || skillMdDraft)
          setSkillMdEditing(false)
          setSkillMdDirty(false)
          setSkillDetailError(result.skillReadError || '')
        }),
      )
      .catch((err: unknown) => {
        setSkillMdSaveError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setSkillMdSaving(false)
      })
  }

  const navigateFromSkillHistory = (entry: SkillDistillHistoryEntry) => {
    if (entry.taskId && entry.taskId !== activeTaskId) {
      onSelectTaskTab?.(entry.taskId)
    }
    const anchorIndex = extractHistoryAnchorIndex(entry)
    if (anchorIndex !== null) {
      window.setTimeout(() => onSelectSubtask(anchorIndex), entry.taskId && entry.taskId !== activeTaskId ? 120 : 0)
    }
    closeSkillDetail()
  }

  const copySelectedSkillPath = () => {
    const path = selectedSkillDetail?.skillMdPath || selectedSkillRecord?.skillPath || ''
    if (!path) return
    void navigator.clipboard.writeText(path).then(() => {
      setCopiedSkillPath(true)
      window.setTimeout(() => setCopiedSkillPath(false), 1400)
    })
  }

  const distillHistory = selectedSkillDetail?.history ?? []
  const skillMdSectionHeight =
    !skillDetailLoading && distillHistory.length > 0 ? 'min(420px, 48vh)' : 'min(580px, 70vh)'

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
        minWidth: 0,
      }}
    >
      <div
        style={{
          flexShrink: 0,
          padding: '0 0 0',
          marginBottom: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div>
          <button
            type="button"
            onClick={() => setLegendExpanded((v) => !v)}
            style={{
              border: 'none',
              background: 'transparent',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 10,
              fontWeight: 600,
              color: '#6A6A6A',
              cursor: 'pointer',
            }}
            aria-expanded={legendExpanded}
          >
            <span style={{ fontSize: 10 }}>{legendExpanded ? '-' : '+'}</span>
            Action type legend
          </button>
          {legendExpanded ? <ActionTypeColorLegend paletteId={actionTypePaletteId} /> : null}
        </div>
        {displayTaskTabs.length > 0 ? (
          <div
            role="tablist"
            aria-label="Task segments"
            onPointerEnter={() => experimentTelemetry.enterPanelFocus('task')}
            onPointerLeave={(e) => {
              const related = e.relatedTarget as Node | null
              const column = (e.currentTarget as HTMLElement).closest(
                '[data-exp-focus="trajectory-column"]',
              )
              const stay = Boolean(column && related && column.contains(related))
              experimentTelemetry.leavePanelFocus('task', stay ? 'trajectory' : undefined)
            }}
            style={{
              display: 'flex',
              flexWrap: 'nowrap',
              alignItems: 'flex-end',
              gap: 2,
              overflow: 'hidden',
              borderBottom: '1px solid #D8D8D8',
              padding: '0 2px',
              minHeight: 29,
            }}
          >
            {displayTaskTabs.map((tab, idx) => {
              const isFallbackLive = taskTabs.length === 0
              const active = isFallbackLive || tab.id === activeTaskTabId
              const label = `Task ${idx + 1}`
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    if (!isFallbackLive) onSelectTaskTab?.(tab.id)
                  }}
                  title={
                    isFallbackLive
                      ? 'Task 1 live view from current OpenCode messages'
                      : [
                          tab.title?.trim() || null,
                          tab.description?.trim() || null,
                          `${tab.status === 'pending' ? 'Latest task' : 'Older extracted task'} · ${tab.turnCount} turn${tab.turnCount === 1 ? '' : 's'}`,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                  }
                  style={{
                    flex: '0 1 64px',
                    minWidth: 44,
                    maxWidth: 78,
                    border: active ? '1px solid #D8D8D8' : '1px solid transparent',
                    borderBottomColor: active ? '#FFFFFF' : 'transparent',
                    background: active ? '#FFFFFF' : '#F7F7F7',
                    color: active ? '#171717' : '#707070',
                    borderRadius: '9px 9px 0 0',
                    padding: '5px 8px 6px',
                    marginBottom: 0,
                    fontSize: 10,
                    fontWeight: active ? 750 : 550,
                    lineHeight: '14px',
                    cursor: onSelectTaskTab && !isFallbackLive ? 'pointer' : 'default',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    boxShadow: active ? '0 1px 0 #FFFFFF' : 'none',
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        ) : null}
        {showTaskBrief ? (
          <div
            aria-label="Task summary"
            style={{
              margin: '0 2px',
              padding: '8px 10px',
              borderRadius: 8,
              background: '#F7F7F7',
              border: '1px solid #E8E8E8',
              color: '#4A4A4A',
              fontSize: 11,
              lineHeight: 1.45,
            }}
          >
            {activeTaskTitle ? (
              <div style={{ fontWeight: 650, color: '#2E2E2E', marginBottom: activeTaskDescription ? 4 : 0 }}>
                {activeTaskTitle}
              </div>
            ) : null}
            {activeTaskDescription ? <div>{activeTaskDescription}</div> : null}
          </div>
        ) : null}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          minWidth: 0,
          position: 'relative',
        }}
      >
        <div
          ref={listScrollRef}
          className="hide-scrollbar"
          onScroll={() => {
            updateStickTrajectoryFromScroll()
            experimentTelemetry.onScroll('trajectory', sessionId)
          }}
          onWheel={handleTrajectoryListWheel}
          style={{
            height: '100%',
            width: '100%',
            minWidth: 0,
            overflowY: flowLayoutMode === 'summary' ? 'hidden' : 'auto',
            boxSizing: 'border-box',
            fontSize: 11,
            color: '#333',
            lineHeight: 1.45,
          }}
        >
          {flowLayoutMode === 'summary' ? (
            summaryPanel
          ) : visibleSubtasks.length === 0 ? (
            <span style={{ color: '#AAA', fontSize: 11 }}>No subtasks</span>
          ) : (
            (() => {
              const permMsgId = pendingPermission?.tool?.messageID
              let permissionCardSourceIndex: number | null = null
              if (pendingPermission) {
                if (permMsgId) {
                  for (const { subtask: st, sourceIndex } of visibleSubtasks) {
                    if (st.assistantMessageIndices.some((i) => messages[i]?.info?.id === permMsgId)) {
                      permissionCardSourceIndex = sourceIndex
                      break
                    }
                  }
                }
                if (permissionCardSourceIndex === null) {
                  permissionCardSourceIndex =
                    visibleSubtasks[visibleSubtasks.length - 1]?.sourceIndex ?? null
                }
              }
              const compactionCardSourceIndex =
                recentCompaction != null
                  ? (visibleSubtasks[visibleSubtasks.length - 1]?.sourceIndex ?? null)
                  : null
              const lastSourceIndex =
                visibleSubtasks[visibleSubtasks.length - 1]?.sourceIndex ?? null
              const claimedTraceIds = new Set<string>()
              const tracesBySourceIndex = new Map<number, OcPermissionTraceEvent[]>()
              for (const { subtask: st, sourceIndex } of visibleSubtasks) {
                const msgIds = new Set(
                  st.assistantMessageIndices
                    .map((i) => messages[i]?.info?.id)
                    .filter((id): id is string => Boolean(id)),
                )
                const matched = permissionTraces.filter(
                  (t) => t.tool?.messageID && msgIds.has(t.tool.messageID),
                )
                for (const t of matched) claimedTraceIds.add(t.id)
                if (matched.length) tracesBySourceIndex.set(sourceIndex, matched)
              }
              const orphanTraces = permissionTraces.filter((t) => !claimedTraceIds.has(t.id))
              if (lastSourceIndex != null && orphanTraces.length > 0) {
                const prev = tracesBySourceIndex.get(lastSourceIndex) ?? []
                tracesBySourceIndex.set(lastSourceIndex, [...prev, ...orphanTraces])
              }
              return visibleSubtasks.map(({ subtask: st, sourceIndex }, si) => {
              const currentUserIndex = firstUserMessageIndex(st)
              const previous = si > 0 ? visibleSubtasks[si - 1] : null
              const previousUserIndex = previous ? firstUserMessageIndex(previous.subtask) : null
              const startsNewPrompt =
                si > 0 &&
                currentUserIndex !== null &&
                currentUserIndex !== previousUserIndex
              const feedbackSelected = feedbackMode && selectedFeedbackIndexSet.has(sourceIndex)
              const hasPanelFeedback = Boolean(panelFeedbackByIndex[sourceIndex]?.trim())
              const showPendingPermission = permissionCardSourceIndex === sourceIndex
              const showRecentCompaction = compactionCardSourceIndex === sourceIndex
              const cardPermissionTraces = tracesBySourceIndex.get(sourceIndex) ?? []

              return (
                <Fragment
                  key={`${st.subtask_id}:${sourceIndex}:${st.assistantMessageIndices[0] ?? -1}:${st.assistantMessageIndices[st.assistantMessageIndices.length - 1] ?? -1}:${st.assistantMessageIndices.length}`}
                >
                  {startsNewPrompt ? (
                    <div
                      aria-label={`User prompt ${currentUserIndex + 1}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        margin: '12px 2px 10px',
                        color: '#8A8A8A',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: 0.2,
                      }}
                    >
                      <span style={{ height: 1, flex: 1, background: '#E0E0E0' }} />
                      <span style={{ whiteSpace: 'nowrap' }}>New user prompt</span>
                      <span style={{ height: 1, flex: 1, background: '#E0E0E0' }} />
                    </div>
                  ) : null}
                  <div data-subtask-panel-id={st.subtask_id}>
                    <SubtaskCard
                    subtask={st}
                    messages={messages}
                    displayIndex={si}
                    cardIndex={sourceIndex}
                    isLinked={feedbackSelected || (!feedbackMode && linkedSubtaskIndex === sourceIndex)}
                    onSelectSubtask={() => {
                      if (feedbackMode) {
                        toggleFeedbackPanel(sourceIndex)
                        return
                      }
                      const latestSourceIndex =
                        visibleSubtasks[visibleSubtasks.length - 1]?.sourceIndex
                      if (
                        latestSourceIndex !== undefined &&
                        sourceIndex !== latestSourceIndex
                      ) {
                        setStickTrajectoryToBottom(false)
                      }
                      onSelectSubtask(sourceIndex)
                    }}
                    onForkFromAction={onForkFromAction}
                    onAnalyzeFromAction={onAnalyzeFromAction}
                    sessionDirectory={sessionDirectory}
                    forkPanelSnapshotBundle={forkPanelSnapshotBundle}
                    selectedActionKey={
                      selection && selection.subtaskIndex === sourceIndex ? selection.actionKey : null
                    }
                    otherSubtaskHasSelection={false}
                    onSelectActionFromFlow={
                      onSelectAction ? (key) => onSelectAction(sourceIndex, key) : undefined
                    }
                    colorBy={colorBy}
                    onColorByChange={setColorBy}
                    actionTypePaletteId={actionTypePaletteId}
                    errorDiagnosis={errorDiagnosisBySubtaskId[st.subtask_id]}
                    onPanelSealed={onPanelSealed}
                    feedbackMode={feedbackMode}
                    isFeedbackSelected={feedbackSelected}
                    hasFeedbackComment={hasPanelFeedback}
                    onToggleFeedbackSelection={() => toggleFeedbackPanel(sourceIndex)}
                    onOpenFeedbackComment={() => openPanelFeedbackEditor(sourceIndex)}
                    pendingPermission={pendingPermission}
                    showPendingPermission={showPendingPermission}
                    permissionTraces={cardPermissionTraces}
                    recentCompaction={recentCompaction}
                    showRecentCompaction={showRecentCompaction}
                  />
                  </div>
                </Fragment>
              )
            })
            })()
          )}
        </div>
      </div>
      {canShowSkillDock ? (
        <div
          onPointerEnter={() => experimentTelemetry.enterPanelFocus('skill')}
          onPointerLeave={(e) => {
            const related = e.relatedTarget as Node | null
            const column = (e.currentTarget as HTMLElement).closest(
              '[data-exp-focus="trajectory-column"]',
            )
            const stay = Boolean(column && related && column.contains(related))
            experimentTelemetry.leavePanelFocus('skill', stay ? 'trajectory' : undefined)
          }}
          style={{
            flexShrink: 0,
            marginTop: 8,
            border: '1px solid #D8DEE8',
            borderRadius: 8,
            background: '#FBFCFE',
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
            boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexShrink: 0 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#1F2937' }}>
                Skill Panel
              </div>
              <div style={{ fontSize: 9, color: '#667085', marginTop: 1 }}>
                Session skills{sessionSkills.length > 0 ? ` · ${sessionSkills.length}` : ''}
              </div>
            </div>
            <span
              style={{
                fontSize: 9,
                color:
                  sessionSkillStatus === 'ready'
                    ? '#166534'
                    : sessionSkillStatus === 'distilling' || sessionSkillLoading
                    ? '#92400E'
                    : sessionSkillStatus === 'error'
                    ? '#991B1B'
                    : '#8A8A8A',
                border: '1px solid #E1E1E1',
                borderRadius: 999,
                padding: '1px 6px',
                background: '#FFFFFF',
                whiteSpace: 'nowrap',
              }}
            >
              {sessionSkillLoading
                ? '加载中'
                : sessionSkillStatus === 'ready'
                ? '已就绪'
                : sessionSkillStatus === 'distilling'
                ? '正在沉淀…'
                : sessionSkillStatus === 'error'
                ? '沉淀失败'
                : '暂无'}
            </span>
          </div>

          {sessionSkillStatus === 'distilling' || sessionSkillLoading ? (
            <div style={{ fontSize: 10, color: '#92400E', lineHeight: 1.4 }}>
              正在根据上一任务的 trace 沉淀 skill，完成后会自动出现在下方，无需手动刷新。
            </div>
          ) : null}

          {sessionSkills.length > 0 || sessionSkillError || (!sessionSkillLoading && sessionTaskIds.length > 0) ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minHeight: 0, maxHeight: 'min(160px, 28vh)', overflowY: 'auto' }}>
            {sessionSkills.length > 0 ? (
              sessionSkills.map((skill, idx) => (
                <button
                  key={`${skill.taskId}:${skill.skillPath || skill.skillName}:${idx}`}
                  type="button"
                  onClick={() => openSkillDetail(skill)}
                  style={{
                    width: '100%',
                    minHeight: 32,
                    border: '1px solid #D7E0EA',
                    background: '#FFFFFF',
                    borderRadius: 9,
                    padding: '5px 8px',
                    textAlign: 'left',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                  title="Open skill record"
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      background: '#16A34A',
                      flex: '0 0 auto',
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 750,
                        color: '#1F2937',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {skill.skillName || '(unnamed skill)'}
                    </div>
                    <div
                      style={{
                        fontSize: 9,
                        color: '#667085',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {skill.feedbackRunDir ? 'feedback distill record' : skill.operation || 'skill record'}
                      {skill.createdAt ? ` · ${new Date(skill.createdAt).toLocaleString()}` : ''}
                    </div>
                  </div>
                  <span
                    style={{
                      flex: '0 0 auto',
                      fontSize: 9,
                      color: '#475467',
                      border: '1px solid #E4E7EC',
                      borderRadius: 999,
                      padding: '1px 6px',
                      background: '#F9FAFB',
                    }}
                  >
                    open
                  </span>
                </button>
              ))
            ) : sessionSkillError ? (
              <div
                style={{
                  minHeight: 32,
                  border: '1px solid #F2C6C6',
                  borderRadius: 9,
                  background: '#FFF7F7',
                  color: '#991B1B',
                  padding: '7px 8px',
                  fontSize: 10,
                  lineHeight: 1.35,
                }}
              >
                {sessionSkillError}
              </div>
            ) : !sessionSkillLoading ? (
              <div
                style={{
                  minHeight: 32,
                  border: '1px dashed #CBD5E1',
                  borderRadius: 9,
                  background: '#FFFFFF',
                  color: '#667085',
                  padding: '7px 8px',
                  fontSize: 10,
                  lineHeight: 1.35,
                }}
              >
                No linked skill
                {sessionSkillDiscoveredCount > 0 ? ` (${sessionSkillDiscoveredCount} discovered)` : ''}.
              </div>
            ) : null}
          </div>
          ) : null}

          {feedbackMode ? (
            <>
              <div
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  border: '1px solid #D8D8D8',
                  borderRadius: 7,
                  overflow: 'hidden',
                  background: hasSelectedFeedbackPanels ? '#FFFFFF' : '#F8F9FB',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 7px',
                    borderBottom: '1px solid #EEF2F6',
                    background: '#F8FAFC',
                  }}
                >
                  <button
                    type="button"
                    onClick={selectAllFeedbackPanels}
                    style={{
                      border: '1px solid #CBD5E1',
                      borderRadius: 999,
                      background: '#FFFFFF',
                      color: '#334155',
                      padding: '2px 7px',
                      fontSize: 9,
                      lineHeight: '14px',
                      fontWeight: 650,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={deselectAllFeedbackPanels}
                    style={{
                      border: '1px solid #CBD5E1',
                      borderRadius: 999,
                      background: '#FFFFFF',
                      color: '#334155',
                      padding: '2px 7px',
                      fontSize: 9,
                      lineHeight: '14px',
                      fontWeight: 650,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Deselect all
                  </button>
                  <span style={{ fontSize: 9, color: '#64748B', lineHeight: '16px' }}>
                    Selected:{' '}
                    <span style={{ fontWeight: 650, color: '#334155' }}>{feedbackScopeLabel}</span>
                  </span>
                  {panelsWithPanelComments.map((panel) => (
                    <button
                      key={panel.sourceIndex}
                      type="button"
                      onClick={() => openPanelFeedbackEditor(panel.sourceIndex)}
                      title={panel.comment}
                      style={{
                        border: '1px solid #9AC2F8',
                        borderRadius: 999,
                        background: '#F0F7FF',
                        color: '#185EA8',
                        padding: '2px 7px',
                        fontSize: 9,
                        lineHeight: '14px',
                        fontWeight: 650,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Panel #{panel.sourceIndex + 1} · note
                    </button>
                  ))}
                </div>
                <textarea
                  value={skillComment}
                  onChange={(e) => setSkillComment(e.target.value)}
                  disabled={!hasSelectedFeedbackPanels}
                  placeholder={feedbackInputPlaceholder}
                  rows={2}
                  style={{
                    width: '100%',
                    resize: 'vertical',
                    minHeight: 42,
                    maxHeight: 96,
                    boxSizing: 'border-box',
                    border: 'none',
                    borderRadius: 0,
                    padding: '6px 7px',
                    fontSize: 10,
                    lineHeight: 1.35,
                    color: hasSelectedFeedbackPanels ? '#333' : '#9CA3AF',
                    background: 'transparent',
                    cursor: hasSelectedFeedbackPanels ? 'text' : 'not-allowed',
                    fontFamily: 'inherit',
                    outline: 'none',
                  }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => {
                    setFeedbackMode(false)
                    setSelectedFeedbackSubtaskIndices([])
                    setPanelFeedbackByIndex({})
                    setEditingFeedbackSubtaskIndex(null)
                    setDraftPanelFeedback('')
                    setSkillComment('')
                  }}
                  style={{
                    border: '1px solid #D8D8D8',
                    borderRadius: 7,
                    background: '#FFFFFF',
                    color: '#666',
                    padding: '4px 8px',
                    fontSize: 10,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDistillSkill}
                  disabled={distillButtonDisabled}
                  style={{
                    flex: 1,
                    minHeight: 36,
                    border: '1px solid #CFCFCF',
                    borderRadius: 9,
                    background: distillButtonDisabled ? '#F0F0F0' : '#111827',
                    color: distillButtonDisabled ? '#9A9A9A' : '#FFFFFF',
                    padding: '6px 10px',
                    fontSize: 13,
                    lineHeight: '22px',
                    fontWeight: 700,
                    cursor: distillButtonDisabled ? 'not-allowed' : 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Distill
                </button>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'stretch' }}>
              <button
                type="button"
                onClick={enterFeedbackMode}
                disabled={sessionSkillLoading}
                style={{
                  width: '100%',
                  minHeight: 36,
                  border: '1px solid #CBD5E1',
                  borderRadius: 9,
                  background: '#FFFFFF',
                  color: '#1F2937',
                  padding: '6px 10px',
                  fontSize: 13,
                  lineHeight: '22px',
                  fontWeight: 700,
                  cursor: sessionSkillLoading ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                Feedback
              </button>
            </div>
          )}
        </div>
      ) : null}
      {feedbackMode && editingFeedbackSubtaskIndex !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Panel ${editingFeedbackSubtaskIndex + 1} feedback`}
          onClick={() => {
            setEditingFeedbackSubtaskIndex(null)
            setDraftPanelFeedback('')
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            background: 'rgba(15, 23, 42, 0.22)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            boxSizing: 'border-box',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(520px, 100%)',
              border: '1px solid #D9E5F7',
              borderRadius: 14,
              background: '#FFFFFF',
              boxShadow: '0 18px 50px rgba(15, 23, 42, 0.22)',
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              fontFamily: 'inherit',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 750, color: '#1F2937' }}>
                  Panel #{editingFeedbackSubtaskIndex + 1} feedback
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingFeedbackSubtaskIndex(null)
                  setDraftPanelFeedback('')
                }}
                aria-label="Close panel feedback dialog"
                style={{
                  border: 'none',
                  background: '#F3F4F6',
                  color: '#4B5563',
                  borderRadius: 8,
                  width: 28,
                  height: 28,
                  cursor: 'pointer',
                  fontSize: 16,
                  lineHeight: '24px',
                }}
              >
                ×
              </button>
            </div>
            <textarea
              value={draftPanelFeedback}
              onChange={(e) => setDraftPanelFeedback(e.target.value)}
              rows={5}
              autoFocus
              placeholder="Panel-specific feedback"
              style={{
                width: '100%',
                resize: 'vertical',
                minHeight: 110,
                maxHeight: 220,
                boxSizing: 'border-box',
                border: '1px solid #CFE0F6',
                borderRadius: 10,
                padding: '9px 10px',
                fontSize: 12,
                lineHeight: 1.5,
                color: '#1F2937',
                background: '#FBFDFF',
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  const index = editingFeedbackSubtaskIndex
                  setPanelFeedbackByIndex((prev) => {
                    const next = { ...prev }
                    delete next[index]
                    return next
                  })
                  setEditingFeedbackSubtaskIndex(null)
                  setDraftPanelFeedback('')
                }}
                style={{
                  border: '1px solid #E5E7EB',
                  borderRadius: 8,
                  background: '#FFFFFF',
                  color: '#6B7280',
                  padding: '6px 10px',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                Clear
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    setEditingFeedbackSubtaskIndex(null)
                    setDraftPanelFeedback('')
                  }}
                  style={{
                    border: '1px solid #E5E7EB',
                    borderRadius: 8,
                    background: '#FFFFFF',
                    color: '#4B5563',
                    padding: '6px 12px',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const index = editingFeedbackSubtaskIndex
                    const text = draftPanelFeedback.trim()
                    setSelectedFeedbackSubtaskIndices((prev) =>
                      prev.includes(index) ? prev : [...prev, index].sort((a, b) => a - b),
                    )
                    setPanelFeedbackByIndex((prev) => {
                      if (!text) {
                        const next = { ...prev }
                        delete next[index]
                        return next
                      }
                      return { ...prev, [index]: text }
                    })
                    setEditingFeedbackSubtaskIndex(null)
                    setDraftPanelFeedback('')
                  }}
                  style={{
                    border: '1px solid #7EB3F5',
                    borderRadius: 8,
                    background: '#EAF4FF',
                    color: '#185EA8',
                    padding: '6px 14px',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {selectedSkillRecord ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Skill detail"
          onClick={closeSkillDetail}
          onPointerEnter={() => experimentTelemetry.enterPanelFocus('skill')}
          onPointerLeave={() => experimentTelemetry.leavePanelFocus('skill', 'trajectory')}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            background: 'rgba(15, 23, 42, 0.30)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 18,
            boxSizing: 'border-box',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(980px, 100%)',
              maxHeight: 'min(760px, 92vh)',
              border: '1px solid #D8DEE8',
              borderRadius: 16,
              background: '#FFFFFF',
              boxShadow: '0 22px 70px rgba(15, 23, 42, 0.28)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              fontFamily: 'inherit',
            }}
          >
            <div
              style={{
                padding: '14px 16px',
                borderBottom: '1px solid #EAECF0',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#111827' }}>
                  {selectedSkillRecord.skillName || '(unnamed skill)'}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 10,
                    color: '#667085',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {selectedSkillDetail?.skillMdPath || selectedSkillRecord.skillPath || 'Loading path...'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flex: '0 0 auto', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={copySelectedSkillPath}
                  disabled={!selectedSkillDetail?.skillMdPath && !selectedSkillRecord.skillPath}
                  style={{
                    border: '1px solid #CBD5E1',
                    borderRadius: 8,
                    background: copiedSkillPath ? '#ECFDF3' : '#FFFFFF',
                    color: copiedSkillPath ? '#027A48' : '#344054',
                    padding: '6px 10px',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor:
                      !selectedSkillDetail?.skillMdPath && !selectedSkillRecord.skillPath
                        ? 'not-allowed'
                        : 'pointer',
                  }}
                >
                  {copiedSkillPath ? 'Copied' : 'Copy path'}
                </button>
                <button
                  type="button"
                  onClick={closeSkillDetail}
                  aria-label="Close skill detail"
                  style={{
                    border: 'none',
                    background: '#F3F4F6',
                    color: '#4B5563',
                    borderRadius: 8,
                    width: 30,
                    height: 30,
                    cursor: 'pointer',
                    fontSize: 17,
                    lineHeight: '26px',
                  }}
                >
                  ×
                </button>
              </div>
            </div>

            <div
              style={{
                padding: 14,
                overflow: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <section
                style={{
                  minWidth: 0,
                  border: '1px solid #EAECF0',
                  borderRadius: 12,
                  background: '#FCFCFD',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  flex: '0 0 auto',
                  height: skillMdSectionHeight,
                  minHeight: skillMdSectionHeight,
                  maxHeight: skillMdSectionHeight,
                }}
              >
                <div
                  style={{
                    padding: '8px 10px',
                    borderBottom: '1px solid #EAECF0',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: '#1F2937' }}>SKILL.md</div>
                    {skillMdEditing ? (
                      <span style={{ fontSize: 9, color: '#185EA8', fontWeight: 700 }}>Editing</span>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flex: '0 0 auto', alignItems: 'center' }}>
                    {skillMdEditing ? (
                      <>
                        <button
                          type="button"
                          onClick={cancelSkillMdEdit}
                          disabled={skillMdSaving}
                          style={{
                            border: '1px solid #E5E7EB',
                            borderRadius: 7,
                            background: '#FFFFFF',
                            color: '#4B5563',
                            padding: '4px 8px',
                            fontSize: 10,
                            cursor: skillMdSaving ? 'not-allowed' : 'pointer',
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={saveSkillMdDraft}
                          disabled={skillMdSaving || skillDetailLoading || !skillMdDraft.trim() || !skillMdDirty}
                          style={{
                            border: '1px solid #7EB3F5',
                            borderRadius: 7,
                            background:
                              skillMdSaving || skillDetailLoading || !skillMdDraft.trim() || !skillMdDirty
                                ? '#EAF4FF'
                                : '#185EA8',
                            color:
                              skillMdSaving || skillDetailLoading || !skillMdDraft.trim() || !skillMdDirty
                                ? '#98A2B3'
                                : '#FFFFFF',
                            padding: '4px 10px',
                            fontSize: 10,
                            fontWeight: 700,
                            cursor:
                              skillMdSaving || skillDetailLoading || !skillMdDraft.trim() || !skillMdDirty
                                ? 'not-allowed'
                                : 'pointer',
                          }}
                        >
                          {skillMdSaving ? 'Saving…' : 'Save'}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={enterSkillMdEdit}
                        disabled={skillDetailLoading || Boolean(skillDetailError && !selectedSkillDetail?.skillMd)}
                        style={{
                          border: '1px solid #7EB3F5',
                          borderRadius: 7,
                          background: '#EAF4FF',
                          color: '#185EA8',
                          padding: '4px 10px',
                          fontSize: 10,
                          fontWeight: 700,
                          cursor:
                            skillDetailLoading || Boolean(skillDetailError && !selectedSkillDetail?.skillMd)
                              ? 'not-allowed'
                              : 'pointer',
                        }}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </div>
                {skillDetailLoading ? (
                  <div style={{ padding: 12, fontSize: 11, color: '#667085', flex: 1 }}>Loading SKILL.md...</div>
                ) : (
                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      margin: 8,
                      display: 'flex',
                      flexDirection: 'column',
                      overflow: 'hidden',
                    }}
                  >
                    {skillMdEditing ? (
                      <textarea
                        value={skillMdDraft}
                        onChange={(e) => {
                          setSkillMdDraft(e.target.value)
                          setSkillMdDirty(e.target.value !== (selectedSkillDetail?.skillMd || ''))
                          setSkillMdSaveError('')
                        }}
                        autoFocus
                        spellCheck={false}
                        style={{
                          margin: 0,
                          padding: 12,
                          flex: 1,
                          minHeight: 0,
                          width: '100%',
                          boxSizing: 'border-box',
                          resize: 'none',
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          fontSize: 11,
                          lineHeight: 1.55,
                          color: '#111827',
                          background: '#FFFFFF',
                          border: '2px solid #7EB3F5',
                          borderRadius: 10,
                          outline: 'none',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        }}
                      />
                    ) : (
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={enterSkillMdEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            enterSkillMdEdit()
                          }
                        }}
                        title="Click to edit SKILL.md"
                        style={{
                          flex: 1,
                          minHeight: 0,
                          overflow: 'auto',
                          borderRadius: 10,
                          border: '1px dashed #CBD5E1',
                          background: '#FFFFFF',
                          cursor: skillDetailError && !selectedSkillDetail?.skillMd ? 'not-allowed' : 'pointer',
                          transition: 'border-color 120ms ease, box-shadow 120ms ease',
                        }}
                        onMouseEnter={(e) => {
                          if (skillDetailError && !selectedSkillDetail?.skillMd) return
                          e.currentTarget.style.borderColor = '#7EB3F5'
                          e.currentTarget.style.boxShadow = 'inset 0 0 0 1px #B2DDFF'
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = '#CBD5E1'
                          e.currentTarget.style.boxShadow = 'none'
                        }}
                      >
                        <pre
                          style={{
                            margin: 0,
                            padding: 12,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            fontSize: 11,
                            lineHeight: 1.55,
                            color: '#111827',
                            background: 'transparent',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                          }}
                        >
                          {selectedSkillDetail?.skillMd || skillDetailError || 'No SKILL.md content.'}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
                {skillDetailError ? (
                  <div style={{ padding: '0 12px 10px', fontSize: 10, color: '#B42318' }}>{skillDetailError}</div>
                ) : null}
                {skillMdSaveError ? (
                  <div style={{ padding: '0 12px 10px', fontSize: 10, color: '#B42318' }}>{skillMdSaveError}</div>
                ) : null}
              </section>

              {!skillDetailLoading && distillHistory.length > 0 ? (
              <section
                style={{
                  minWidth: 0,
                  border: '1px solid #EAECF0',
                  borderRadius: 12,
                  background: '#FFFFFF',
                  padding: '8px 10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  flex: '0 0 auto',
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 800, color: '#1F2937' }}>Distill History</div>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    border: '1px solid #EAECF0',
                    borderRadius: 8,
                    background: '#FCFCFD',
                    overflow: 'hidden',
                  }}
                >
                  {distillHistory.map((entry, index) => {
                    const badge = operationBadgeStyle(entry.operation)
                    const operationLabel = String(entry.operation || 'UPDATE').toUpperCase()
                    const sourceLabel = historyEntrySourceLabel(entry)
                    const anchorIndex = extractHistoryAnchorIndex(entry)
                    const canNavigate = Boolean(entry.taskId) || anchorIndex !== null
                    const bodyText = historyEntryBodyText(entry)
                    const userComment = historyEntryUserComment(entry, bodyText)
                    const traceQuote = historyEntryTraceQuote(entry, bodyText)
                    const changePaths = historyEntryChangePaths(entry)
                    const navigateLabel = historyEntryNavigateLabel(entry, anchorIndex)
                    const rowKey = entry.id || `${entry.createdAt}-${index}`
                    return (
                      <div
                        key={rowKey}
                        role={canNavigate ? 'button' : undefined}
                        tabIndex={canNavigate ? 0 : undefined}
                        onClick={canNavigate ? () => navigateFromSkillHistory(entry) : undefined}
                        onKeyDown={
                          canNavigate
                            ? (event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  navigateFromSkillHistory(entry)
                                }
                              }
                            : undefined
                        }
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          padding: '10px 12px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          borderBottom: index < distillHistory.length - 1 ? '1px solid #EAECF0' : undefined,
                          cursor: canNavigate ? 'pointer' : 'default',
                          background: 'transparent',
                        }}
                        onMouseEnter={(event) => {
                          if (canNavigate) event.currentTarget.style.background = '#F9FAFB'
                        }}
                        onMouseLeave={(event) => {
                          event.currentTarget.style.background = 'transparent'
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 8,
                            flexWrap: 'wrap',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span
                              style={{
                                fontSize: 9,
                                fontWeight: 800,
                                color: badge.color,
                                background: badge.bg,
                                border: `1px solid ${badge.border}`,
                                borderRadius: 999,
                                padding: '1px 7px',
                              }}
                            >
                              {operationLabel}
                            </span>
                            <span style={{ fontSize: 9, color: '#98A2B3', whiteSpace: 'nowrap' }}>
                              {formatHistoryTimestamp(entry.createdAt)}
                            </span>
                            {sourceLabel ? (
                              <span
                                style={{
                                  fontSize: 9,
                                  fontWeight: 700,
                                  color: sourceLabel === 'Feedback' ? '#92400E' : '#5925DC',
                                  background: sourceLabel === 'Feedback' ? '#FFFAEB' : '#F4F3FF',
                                  border: `1px solid ${sourceLabel === 'Feedback' ? '#FEDF89' : '#D9D6FE'}`,
                                  borderRadius: 999,
                                  padding: '1px 7px',
                                }}
                              >
                                {sourceLabel}
                              </span>
                            ) : null}
                          </div>
                          {navigateLabel ? (
                            <span
                              style={{
                                fontSize: 9,
                                fontWeight: 700,
                                color: '#475467',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {navigateLabel} →
                            </span>
                          ) : null}
                        </div>

                        <div
                          style={{
                            fontSize: 10,
                            color: '#111827',
                            lineHeight: 1.55,
                            wordBreak: 'break-word',
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {bodyText}
                        </div>

                        {userComment ? (
                          <div
                            style={{
                              fontSize: 9,
                              color: '#92400E',
                              lineHeight: 1.5,
                              padding: '5px 8px',
                              borderRadius: 7,
                              background: '#FFFAEB',
                              border: '1px solid #FEDF89',
                              wordBreak: 'break-word',
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            User: {userComment}
                          </div>
                        ) : null}

                        {traceQuote ? (
                          <div
                            style={{
                              fontSize: 9,
                              color: '#667085',
                              lineHeight: 1.5,
                              wordBreak: 'break-word',
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            「{traceQuote}」
                          </div>
                        ) : null}

                        {changePaths.length > 0 ? (
                          <div style={{ fontSize: 9, color: '#667085', lineHeight: 1.5 }}>
                            Changed: {changePaths.join('、')}
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </section>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
