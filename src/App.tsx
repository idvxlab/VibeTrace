import { useState, useEffect, useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { OcSession } from './types/opencode'
import {
  getCurrentWorkspaceDirectory,
  getProjectDirectories,
  getSessions,
  getTodos,
  getMessages,
  sendMessage,
  getComposerModelOptions,
  abortSession,
  forkSession,
  createSession,
  updateSessionTitle,
  deleteSession,
  replyToQuestion,
  rejectQuestion,
  subscribeGlobalEvents,
  type OcComposerModelOption,
} from './services/opencodeApi'
import {
  normalizeSessionDirectory,
  uniqueDirectoriesFromSessions,
} from './utils/sessionFolders'
import type { MappedAction, OcMessage, OcPendingQuestionRequest, OcTodo } from './types/opencode'
import type { TurnTrace } from './types/trace'
import type { MessageSendPayload } from './components/MessageInput'
import Sidebar from './components/Sidebar'
import MessagePanel from './components/MessagePanel'
import SubtaskDebugPanel from './components/SubtaskDebugPanel'
import FullscreenSubtaskPanel from './components/FullscreenSubtaskPanel'
import ActionAnalysisModal from './components/ActionAnalysisModal'
import ForkSessionModal from './components/ForkSessionModal'
import SubtaskMessageConnector from './components/SubtaskMessageConnector'
import { groupAssistantSubtasks, isTodoWriteMessage } from './utils/subtaskGrouping'
import {
  findSubtaskIndexForTodo,
  subtaskShouldUseTodoLink,
} from './utils/subtaskLinkage'
import { actionKeyMessageId } from './utils/actionKey'
import { firstFlowAnchorKeyForSubtaskSegment } from './utils/actionMapping'
import { parseActionRelatedSseEvent } from './utils/opencodeSse'
import {
  archivedCompletedList,
  buildSessionTodoModel,
  getLatestTodowriteBatchProgress,
} from './utils/todoRegistry'
import { SHOW_COMPOSER_MODEL_UI } from './config/featureFlags'
import { STORAGE_KEYS } from './config/storageKeys'
import { buildUserMessageWithGuidance } from './config/harnessGuidance'
import {
  buildForkPanelSnapshotBundle,
  getForkPanelSnapshotBundle,
  saveForkPanelSnapshotBundle,
  type ForkFromActionContext,
  type ForkPanelSnapshotBundle,
} from './utils/forkPanelSnapshot'
import {
  findLatestAssistantStopMessage,
  getAssistantStopCompletedMs,
  isAssistantStopWithinIngestWindow,
  TRACE_INGEST_FRESH_WINDOW_MS,
} from './utils/traceExtraction'
import { resolveForkIngestMeta } from './utils/traceForkIngest'
import {
  hasTraceIngestClaim,
  releaseTraceIngestClaim,
  tryClaimTraceIngest,
} from './utils/traceIngestClaim'
import { fetchPanelAnalysisForSession, inheritForkTaskState, ingestTraceReference, notifyTaskSwitchPrompt, type MemoryWorkerErrorDiagnosis, type MemoryWorkerIngestResult, type MemoryWorkerTaskSegment } from './services/memoryWorkerApi'
import { mergePanelAnalysisItemsIntoBucket } from './utils/panelAnalysisStorage'
import {
  collectInternalSessionIdsFromIngest,
  registerMemoryWorkerInternalSessionIds,
  shouldSkipTraceIngestForSession,
} from './utils/memoryWorkerSessions'
import { traceSessionTurnLimit } from './config/traceIngest'

declare global {
  interface Window {
    __vibetraceDebug?: {
      getMessages: () => Promise<OcMessage[]>
      latestTrace: () => TurnTrace | null
    }
  }
}

/** Map: message index containing a todo write → todos captured at that instant (for replaying diffs) */
type TodosSnapshotMap = Record<string, OcTodo[]>
type TaskSegmentStatus = 'pending' | 'extracted'
type TaskSegmentTab = {
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
}
const AUTO_ABORT_STUCK_RUNNING_AFTER_MS = 24 * 60 * 60 * 1000
const TRACE_EXTRACTION_DEBOUNCE_MS = 650
const SSE_SYNC_DEBOUNCE_MS = 350
const DEBUG_VERBOSE_LOGS =
  String(import.meta.env.VITE_DEBUG_VERBOSE_LOGS ?? '')
    .trim()
    .toLowerCase() === 'true'

/** If SSE lags after send, poll GET /message until an assistant message appears (streaming / long runs) */
const POLL_ASSISTANT_INTERVAL_MS = 2000
const POLL_ASSISTANT_MAX_ROUNDS = 90
const MESSAGE_PANEL_MIN_WIDTH = 420
const SUBTASK_PANEL_DEFAULT_WIDTH = 630
const SUBTASK_PANEL_MIN_WIDTH = 420
const SUBTASK_PANEL_MAX_WIDTH = 1040

function taskSegmentId(status: TaskSegmentStatus, segment: MemoryWorkerTaskSegment): string {
  return segment.taskId || `${status}:${segment.fromEndAssistantMessageId}:${segment.toEndAssistantMessageId}`
}

function taskSegmentFromWorker(
  status: TaskSegmentStatus,
  segment: MemoryWorkerTaskSegment,
  meta?: Pick<TaskSegmentTab, 'taskSwitchRunDir' | 'pipelineRunDir'>,
): TaskSegmentTab | null {
  if (!segment.fromStartUserMessageId || !segment.toEndAssistantMessageId) return null
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
    ...meta,
  }
}

function isTaskSwitchedIngestResult(result: MemoryWorkerIngestResult): boolean {
  const decision = result.taskSwitch?.decision
  if (!decision || typeof decision !== 'object') return false
  return (decision as { task_switched?: boolean }).task_switched === true
}

function cloneTaskSegmentTabs(tabs: TaskSegmentTab[]): TaskSegmentTab[] {
  return tabs.map((tab) => ({ ...tab }))
}

function resolveTaskTabsSourceSessionId(
  segmentsBySession: Record<string, TaskSegmentTab[]>,
  selectedId: string | undefined,
  forkTargetId: string,
): string | null {
  if (selectedId && (segmentsBySession[selectedId]?.length ?? 0) > 0) return selectedId
  if ((segmentsBySession[forkTargetId]?.length ?? 0) > 0) return forkTargetId
  return null
}

function loadJsonObjectFromLs<T extends Record<string, unknown>>(key: string): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return {} as T
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : ({} as T)
  } catch {
    return {} as T
  }
}

function saveJsonObjectToLs(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

function debugLog(...args: unknown[]): void {
  if (!DEBUG_VERBOSE_LOGS) return
  console.log(...args)
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function loadComposerModelRefFromLs(): string {
  try {
    const v = window.localStorage.getItem(STORAGE_KEYS.composerModelRef)
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''
  }
}

function loadSubtaskPanelWidthFromLs(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.subtaskPanelWidth)
    const n = raw ? Number(raw) : NaN
    if (!Number.isFinite(n)) return SUBTASK_PANEL_DEFAULT_WIDTH
    return clampNumber(n, SUBTASK_PANEL_MIN_WIDTH, SUBTASK_PANEL_MAX_WIDTH)
  } catch {
    return SUBTASK_PANEL_DEFAULT_WIDTH
  }
}

function parseEnvDirectorySeeds(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(/[;\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function directoryKey(dir: string | undefined): string {
  const n = normalizeSessionDirectory(dir)
  if (!n) return ''
  return /^[A-Za-z]:\//.test(n) ? n.toLowerCase() : n
}

function sameDirectory(a: string | undefined, b: string | undefined): boolean {
  return directoryKey(a) === directoryKey(b)
}

function loadManualDirectories(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.manualDirectories)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data
      .map((v) => (typeof v === 'string' ? normalizeSessionDirectory(v) : ''))
      .filter(Boolean)
  } catch {
    return []
  }
}

function loadClosedDirectories(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.closedDirectories)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data
      .map((v) => (typeof v === 'string' ? normalizeSessionDirectory(v) : ''))
      .filter(Boolean)
  } catch {
    return []
  }
}

function promptDirectoryPath(seed: string): string | null {
  const message =
    'Due to browser security restrictions, web pages cannot directly read folder paths on your computer. If you want to create or load a local workspace, please copy the folder absolute path and paste it into the input below.'
  const raw = window.prompt(message, seed)
  if (!raw) return null
  return normalizeSessionDirectory(raw)
}

async function pollUntilAssistantMessage(
  sessionId: string,
  directory: string | undefined,
  isStillSelected: () => boolean,
  onMessages: (msgs: OcMessage[]) => void,
): Promise<void> {
  for (let i = 0; i < POLL_ASSISTANT_MAX_ROUNDS; i++) {
    await new Promise((r) => setTimeout(r, POLL_ASSISTANT_INTERVAL_MS))
    if (!isStillSelected()) return
    try {
      const msgs = await getMessages(sessionId, `poll assistant reply ${i + 1}`, directory)
      onMessages(msgs)
      const last = msgs[msgs.length - 1]
      if (last?.info.role === 'assistant') return
    } catch {
      /* polling continues */
    }
  }
}

function mergeSessionsById(lists: OcSession[][]): OcSession[] {
  const map = new Map<string, OcSession>()
  for (const list of lists) {
    for (const s of list) {
      const cur = map.get(s.id)
      if (!cur || s.time.updated >= cur.time.updated) {
        map.set(s.id, s)
      }
    }
  }
  return [...map.values()]
}

async function fetchSessionsAcrossDirectories(seedDirs: Array<string | undefined>): Promise<OcSession[]> {
  const dedup = Array.from(
    new Set(
      seedDirs
        .map((d) => (typeof d === 'string' ? d.trim() : ''))
        .filter((d) => d.length > 0),
    ),
  )
  const jobs = dedup.map(async (dir) => {
    try {
      return await getSessions({ directory: dir })
    } catch {
      return [] as OcSession[]
    }
  })
  const lists = await Promise.all(jobs)
  return mergeSessionsById(lists)
}

function App() {
  const envDirectorySeeds = useMemo(
    () => parseEnvDirectorySeeds(import.meta.env.VITE_OPENCODE_DIRECTORY_SEEDS),
    [],
  )
  const [sessions, setSessions] = useState<OcSession[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string>('')
  const [messages, setMessages] = useState<OcMessage[]>([])
  const [todos, setTodos] = useState<OcTodo[]>([])
  const [todosSnapshotAtMessageIndex, setTodosSnapshotAtMessageIndex] = useState<TodosSnapshotMap>({})
  const [loading, setLoading] = useState(false)
  const [apiConnected, setApiConnected] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [linkedSubtaskIndex, setLinkedSubtaskIndex] = useState<number | null>(null)
  /** Bumps when a subtask is selected so the Todo panel auto-expands the right section */
  const [todoPanelRevealGeneration, setTodoPanelRevealGeneration] = useState(0)
  const [selectedDirectory, setSelectedDirectory] = useState<string>('')
  const [projectDirectories, setProjectDirectories] = useState<string[]>([])
  const [manualDirectories, setManualDirectories] = useState<string[]>(() => loadManualDirectories())
  const [closedDirectories, setClosedDirectories] = useState<string[]>(() => loadClosedDirectories())
  const [creatingSession, setCreatingSession] = useState(false)
  /** Pending question requests keyed by session (from SSE `question.asked`) */
  const [pendingQuestions, setPendingQuestions] = useState<Record<string, OcPendingQuestionRequest>>({})
  const [questionSubmitting, setQuestionSubmitting] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [analysisAction, setAnalysisAction] = useState<(MappedAction & { row: number }) | null>(null)
  /** Fork workflow: prompt → capture subtask panel snapshot → call OpenCode fork */
  const [pendingFork, setPendingFork] = useState<{
    action: MappedAction & { row: number }
    forkCtx?: ForkFromActionContext
  } | null>(null)
  const [forkBusy, setForkBusy] = useState(false)
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null)
  const [composerModelRef, setComposerModelRef] = useState<string>(() => loadComposerModelRefFromLs())
  const [composerModelOptions, setComposerModelOptions] = useState<OcComposerModelOption[]>([])
  const [composerModelsLoading, setComposerModelsLoading] = useState(false)
  const [composerModelsError, setComposerModelsError] = useState<string | null>(null)
  /** User message sent; still polling for assistant completion */
  const [waitingForAssistantReply, setWaitingForAssistantReply] = useState(false)
  const [latestTurnTrace, setLatestTurnTrace] = useState<TurnTrace | null>(null)
  const [taskSegmentsBySessionId, setTaskSegmentsBySessionId] = useState<Record<string, TaskSegmentTab[]>>(() =>
    loadJsonObjectFromLs<Record<string, TaskSegmentTab[]>>(STORAGE_KEYS.taskSegments),
  )
  const [panelAnalysisBySessionId, setPanelAnalysisBySessionId] = useState<
    Record<string, Record<string, MemoryWorkerErrorDiagnosis>>
  >(() => loadJsonObjectFromLs<Record<string, Record<string, MemoryWorkerErrorDiagnosis>>>(STORAGE_KEYS.panelAnalysis))
  const errorDiagnosisBySubtaskId = useMemo(
    () => (selectedSessionId ? panelAnalysisBySessionId[selectedSessionId] ?? {} : {}),
    [panelAnalysisBySessionId, selectedSessionId],
  )
  const [activeTaskSegmentBySessionId, setActiveTaskSegmentBySessionId] = useState<Record<string, string>>(() =>
    loadJsonObjectFromLs<Record<string, string>>(STORAGE_KEYS.activeTaskSegments),
  )
  const [taskSegmentManuallySelectedBySessionId, setTaskSegmentManuallySelectedBySessionId] = useState<Record<string, boolean>>(() =>
    loadJsonObjectFromLs<Record<string, boolean>>(STORAGE_KEYS.taskSegmentManualSelection),
  )
  /** Ingest completed successfully for this sessionId:stopId */
  const processedTraceTurnKeysRef = useRef<Set<string>>(new Set())
  /** Debounced ingest callback has started (do not release claim on effect cleanup) */
  const traceIngestDebounceStartedRef = useRef<Set<string>>(new Set())

  const pendingForkRef = useRef(pendingFork)
  pendingForkRef.current = pendingFork

  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  const refreshSessions = useCallback(
    async (extraDirectories?: Array<string | undefined>) => {
      const base = await getSessions()
      const discovered = await getProjectDirectories().catch(() => [] as string[])
      const current = await getCurrentWorkspaceDirectory().catch(() => null)
      const mergedDiscovered = Array.from(new Set([...discovered, ...(current ? [current] : [])]))
      setProjectDirectories(mergedDiscovered)
      const closed = new Set(closedDirectories)
      const extra = await fetchSessionsAcrossDirectories([
        ...envDirectorySeeds,
        ...manualDirectories.filter((d) => !closed.has(d)),
        ...(extraDirectories ?? []),
        ...mergedDiscovered.filter((d) => !closed.has(normalizeSessionDirectory(d))),
      ])
      const merged = mergeSessionsById([base, extra]).filter(
        (s) => !closed.has(normalizeSessionDirectory(s.directory)),
      )
      setSessions(merged)
      setApiConnected(true)
      return merged
    },
    [envDirectorySeeds, manualDirectories, closedDirectories],
  )

  const directories = useMemo(() => {
    const fromSession = uniqueDirectoriesFromSessions(sessions)
    const mergedRaw = [
      ...fromSession,
      ...projectDirectories.map((d) => normalizeSessionDirectory(d)),
      ...manualDirectories,
      selectedDirectory,
    ]
    const map = new Map<string, string>()
    for (const dir of mergedRaw) {
      const key = directoryKey(dir)
      if (!key || map.has(key)) continue
      map.set(key, normalizeSessionDirectory(dir))
    }
    const merged = [...map.values()]
      .filter((d) => d !== 'Unknown')
      .filter((d) => d !== '')
      .filter((d) => !closedDirectories.includes(d))
    return merged.sort((a, b) => {
      return a.localeCompare(b, 'zh-CN')
    })
  }, [sessions, projectDirectories, manualDirectories, selectedDirectory, closedDirectories])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.manualDirectories, JSON.stringify(manualDirectories))
  }, [manualDirectories])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.closedDirectories, JSON.stringify(closedDirectories))
  }, [closedDirectories])

  useEffect(() => {
    saveJsonObjectToLs(STORAGE_KEYS.taskSegments, taskSegmentsBySessionId)
  }, [taskSegmentsBySessionId])

  useEffect(() => {
    saveJsonObjectToLs(STORAGE_KEYS.activeTaskSegments, activeTaskSegmentBySessionId)
  }, [activeTaskSegmentBySessionId])

  useEffect(() => {
    saveJsonObjectToLs(STORAGE_KEYS.taskSegmentManualSelection, taskSegmentManuallySelectedBySessionId)
  }, [taskSegmentManuallySelectedBySessionId])

  useEffect(() => {
    saveJsonObjectToLs(STORAGE_KEYS.panelAnalysis, panelAnalysisBySessionId)
  }, [panelAnalysisBySessionId])

  const mergePanelAnalysisItems = useCallback((sessionId: string, items: MemoryWorkerErrorDiagnosis[]) => {
    if (!sessionId || items.length === 0) return
    setPanelAnalysisBySessionId((prev) => {
      const { bucket, changed } = mergePanelAnalysisItemsIntoBucket(prev[sessionId] ?? {}, items)
      if (!changed) return prev
      return { ...prev, [sessionId]: bucket }
    })
  }, [])

  const handleSelectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId)
  }, [])

  const sessionsInFolder = useMemo(() => {
    return sessions
      .filter(s => sameDirectory(s.directory, selectedDirectory))
      .filter(s => !shouldSkipTraceIngestForSession(s.id, s))
      .sort((a, b) => b.time.updated - a.time.updated)
  }, [sessions, selectedDirectory])

  const linkAreaRef = useRef<HTMLDivElement>(null)
  const messageScrollRef = useRef<HTMLDivElement>(null)
  const todoPanelScrollRef = useRef<HTMLDivElement>(null)
  const subtaskScrollRef = useRef<HTMLDivElement>(null)
  const [subtaskPanelWidth, setSubtaskPanelWidth] = useState(() => loadSubtaskPanelWidthFromLs())
  const [isResizingSubtaskPanel, setIsResizingSubtaskPanel] = useState(false)
  const selectedSessionIdRef = useRef(selectedSessionId)
  selectedSessionIdRef.current = selectedSessionId
  const sseSyncTimerRef = useRef<number | null>(null)

  const getSubtaskPanelWidthBounds = useCallback(() => {
    const totalWidth = linkAreaRef.current?.getBoundingClientRect().width ?? window.innerWidth
    const maxByCenter = Math.max(1, totalWidth - MESSAGE_PANEL_MIN_WIDTH)
    const max = Math.max(1, Math.min(SUBTASK_PANEL_MAX_WIDTH, maxByCenter))
    const min = Math.min(SUBTASK_PANEL_MIN_WIDTH, max)
    return { min, max }
  }, [])

  useEffect(() => {
    const clampToAvailableWidth = () => {
      setSubtaskPanelWidth((prev) => {
        const { min, max } = getSubtaskPanelWidthBounds()
        return clampNumber(prev, min, max)
      })
    }
    clampToAvailableWidth()
    window.addEventListener('resize', clampToAvailableWidth)
    return () => window.removeEventListener('resize', clampToAvailableWidth)
  }, [getSubtaskPanelWidthBounds])

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.subtaskPanelWidth, String(Math.round(subtaskPanelWidth)))
    } catch {
      /* ignore */
    }
  }, [subtaskPanelWidth])

  const handleSubtaskPanelResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()

      const startX = event.clientX
      const startWidth = subtaskPanelWidth
      const { min, max } = getSubtaskPanelWidthBounds()
      let latestWidth = clampNumber(startWidth, min, max)
      const previousCursor = document.body.style.cursor
      const previousUserSelect = document.body.style.userSelect

      setIsResizingSubtaskPanel(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const notifyLayoutChanged = () => {
        window.dispatchEvent(new Event('resize'))
      }
      const handlePointerMove = (moveEvent: PointerEvent) => {
        latestWidth = clampNumber(startWidth - (moveEvent.clientX - startX), min, max)
        setSubtaskPanelWidth(latestWidth)
        notifyLayoutChanged()
      }
      const stopResize = () => {
        setIsResizingSubtaskPanel(false)
        document.body.style.cursor = previousCursor
        document.body.style.userSelect = previousUserSelect
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', stopResize)
        window.removeEventListener('pointercancel', stopResize)
        try {
          window.localStorage.setItem(STORAGE_KEYS.subtaskPanelWidth, String(Math.round(latestWidth)))
        } catch {
          /* ignore */
        }
        notifyLayoutChanged()
      }

      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', stopResize)
      window.addEventListener('pointercancel', stopResize)
    },
    [getSubtaskPanelWidthBounds, subtaskPanelWidth],
  )
  const sseSyncDirsRef = useRef<Set<string>>(new Set())

  const pendingQuestionsRef = useRef(pendingQuestions)
  pendingQuestionsRef.current = pendingQuestions
  const autoAbortedRunningKeysRef = useRef<Set<string>>(new Set())

  const activeSessionDirectory = useMemo(
    () => sessions.find(s => s.id === selectedSessionId)?.directory,
    [sessions, selectedSessionId],
  )

  const envBootstrapModel = useMemo(() => {
    const v = import.meta.env.VITE_OPENCODE_DEFAULT_MODEL
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }, [])

  const composerModelOptionsForUi = useMemo(() => {
    const t = composerModelRef.trim()
    if (!t || composerModelOptions.some((o) => o.ref === t)) return composerModelOptions
    return [...composerModelOptions, { ref: t, label: `${t}（本地已保存）` }].sort((a, b) =>
      a.ref.localeCompare(b.ref),
    )
  }, [composerModelOptions, composerModelRef])

  useEffect(() => {
    if (!SHOW_COMPOSER_MODEL_UI) return
    let cancelled = false
    setComposerModelsLoading(true)
    setComposerModelsError(null)
    void getComposerModelOptions(activeSessionDirectory)
      .then(({ options }) => {
        if (!cancelled) setComposerModelOptions(options)
      })
      .catch((e: unknown) => {
        if (!cancelled) setComposerModelsError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setComposerModelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeSessionDirectory])

  const handleComposerModelRefChange = useCallback((ref: string) => {
    const t = ref.trim()
    setComposerModelRef(t)
    try {
      if (t) window.localStorage.setItem(STORAGE_KEYS.composerModelRef, t)
      else window.localStorage.removeItem(STORAGE_KEYS.composerModelRef)
    } catch {
      /* ignore */
    }
  }, [])

  /** Locally cached pre-fork panel snapshot for diffing (not sent to the model) */
  const forkPanelSnapshotBundle = useMemo(
    () => getForkPanelSnapshotBundle(selectedSessionId),
    [selectedSessionId],
  )

  /** Full-screen VibeTrace overlay */
  const [subtaskFullscreenOpen, setSubtaskFullscreenOpen] = useState(false)
  /** Column layout: timeline vs summary */
  const [subtaskFlowLayoutMode, setSubtaskFlowLayoutMode] = useState<'timeline' | 'summary'>('timeline')
  /** Short-lived hint when OpenCode signals `session.compacted` for the active session */
  const [compactionControlHint, setCompactionControlHint] = useState<string | null>(null)
  /** Action rectangle click toggles per-action highlight */
  const [selection, setSelection] = useState<{ subtaskIndex: number; actionKey: string } | null>(null)
  const handleSelectAction = useCallback((subtaskIndex: number, actionKey: string | null) => {
    setSelection((prev) => {
      if (actionKey === null) return null
      if (prev && prev.subtaskIndex === subtaskIndex && prev.actionKey === actionKey) {
        return null
      }
      return { subtaskIndex, actionKey }
    })
    if (actionKey !== null) setLinkedSubtaskIndex(subtaskIndex)
  }, [])

  const handleSelectTaskSegment = useCallback((sessionId: string, taskSegmentId: string) => {
    setTaskSegmentManuallySelectedBySessionId((prev) => ({ ...prev, [sessionId]: true }))
    setActiveTaskSegmentBySessionId((prev) => ({ ...prev, [sessionId]: taskSegmentId }))
  }, [])

  const applyMemoryWorkerTaskSegments = useCallback((sessionId: string, result: MemoryWorkerIngestResult) => {
    console.info('[VibeTrace][task-segments response]', {
      sessionId,
      reason: result.reason,
      ok: result.ok,
      duplicate: result.duplicate,
      pendingTask: result.pendingTask,
      extractedTask: result.extractedTask,
      taskSwitch: result.taskSwitch,
      errorDiagnosis: result.errorDiagnosis,
    })
    const diagnosisItems = result.errorDiagnosis?.items ?? []
    if (diagnosisItems.length > 0) {
      mergePanelAnalysisItems(sessionId, diagnosisItems)
      console.info('[VibeTrace][error-diagnosis received]', {
        sessionId,
        count: diagnosisItems.length,
        items: diagnosisItems.map((item) => ({
          subtaskId: item.subtaskId,
          status: item.status,
          runDir: item.runDir,
          diagnosisSessionID: item.diagnosisSessionID,
          cached: item.cached,
        })),
      })
    }
    const nextTabs: TaskSegmentTab[] = []
    const taskSwitchRunDir = result.taskSwitch?.runDir
    const pipelineRunDir = result.runDir
    if (result.extractedTask) {
      const tab = taskSegmentFromWorker('extracted', result.extractedTask, {
        taskSwitchRunDir,
        pipelineRunDir,
      })
      if (tab) nextTabs.push(tab)
    }
    if (result.pendingTask) {
      const tab = taskSegmentFromWorker('pending', result.pendingTask, {
        taskSwitchRunDir,
      })
      if (tab) nextTabs.push(tab)
    }
    if (nextTabs.length === 0) {
      console.warn('[VibeTrace][task-segments missing]', {
        sessionId,
        reason: result.reason,
        keys: Object.keys(result),
      })
      return
    }

    setTaskSegmentsBySessionId((prev) => {
      const existing = prev[sessionId] ?? []
      const byId = new Map(existing.map((tab) => [tab.id, tab]))
      const taskSwitched = isTaskSwitchedIngestResult(result)
      for (const tab of nextTabs) {
        if (tab.status === 'pending') {
          for (const [id, old] of byId) {
            if (old.status !== 'pending') continue
            if (taskSwitched) {
              byId.set(id, { ...old, status: 'extracted' })
            } else {
              byId.delete(id)
            }
          }
        }
        const prior = byId.get(tab.id)
        byId.set(tab.id, prior ? { ...prior, ...tab } : tab)
      }
      return { ...prev, [sessionId]: [...byId.values()] }
    })

    const preferred = nextTabs.find((tab) => tab.status === 'pending') ?? nextTabs[nextTabs.length - 1]
    if (preferred) {
      setActiveTaskSegmentBySessionId((prev) => {
        if (taskSegmentManuallySelectedBySessionId[sessionId] && prev[sessionId]) return prev
        return { ...prev, [sessionId]: preferred.id }
      })
    }
    console.info('[VibeTrace][task-segments applied]', {
      sessionId,
      added: nextTabs,
      active: preferred?.id,
    })
  }, [taskSegmentManuallySelectedBySessionId, mergePanelAnalysisItems])

  useEffect(() => {
    if (!selectedSessionId) return
    const cached = panelAnalysisBySessionId[selectedSessionId]
    const count = cached ? Object.keys(cached).length : 0
    if (count > 0) {
      console.info('[VibeTrace][panel-analysis] restored from localStorage', {
        sessionId: selectedSessionId,
        count,
      })
    }
  }, [selectedSessionId, panelAnalysisBySessionId])

  /** Clear action-outline selection when clicking outside flow nodes (sidebar, transcript, todos, composer, etc.). Blank flow canvas already clears via `onSelectAction(null)`. */
  useEffect(() => {
    if (selection === null) return
    const onPointerDown = (e: PointerEvent) => {
      const el = e.target
      if (!(el instanceof Element)) return
      if (el.closest('g.afv-action')) return
      const inSubtaskCard = el.closest('[data-subtask-card-index]')
      if (inSubtaskCard) {
        if (el.closest('svg[data-action-flow-root="1"]')) setSelection(null)
        return
      }
      setSelection(null)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [selection])

  // Load sessions on mount
  useEffect(() => {
    refreshSessions()
      .then((data) => {
        const sorted = [...data].sort((a, b) => b.time.updated - a.time.updated)
        if (sorted.length > 0) {
          const first = sorted[0]!
          setSelectedSessionId(first.id)
          setSelectedDirectory(normalizeSessionDirectory(first.directory))
        }
      })
      .catch(() => setApiConnected(false))
  }, [refreshSessions])

  /** If the active session disappears from the list, fall back to newest in folder or globally */
  useEffect(() => {
    if (sessions.length === 0) return
    if (selectedSessionId && sessions.some(s => s.id === selectedSessionId)) return

    const inFolder = sessions
      .filter(s => sameDirectory(s.directory, selectedDirectory))
      .sort((a, b) => b.time.updated - a.time.updated)

    if (inFolder.length > 0) {
      setSelectedSessionId(inFolder[0]!.id)
      return
    }
    if (!selectedSessionId) return

    const sorted = [...sessions].sort((a, b) => b.time.updated - a.time.updated)
    const pick = sorted[0]!
    setSelectedSessionId(pick.id)
    setSelectedDirectory(normalizeSessionDirectory(pick.directory))
  }, [sessions, selectedSessionId, selectedDirectory])

  useEffect(() => {
    setWaitingForAssistantReply(false)
    setLatestTurnTrace(null)
  }, [selectedSessionId])

  useEffect(() => {
    if (!selectedSessionId || loading) return
    const activeSession = sessions.find((s) => s.id === selectedSessionId)
    if (shouldSkipTraceIngestForSession(selectedSessionId, activeSession)) {
      debugLog('[VibeTrace][trace] skip ingest for memory-worker internal session', {
        sessionID: selectedSessionId,
        title: activeSession?.title,
      })
      return
    }
    const stopMessage = findLatestAssistantStopMessage(messages)
    if (!stopMessage) return

    const stopId = stopMessage.info.id
    // stop 已出现 → 结束时间在 2 分钟内 且 未 claim → 才 ingest（见下方顺序）
    if (!isAssistantStopWithinIngestWindow(stopMessage)) {
      const completedMs = getAssistantStopCompletedMs(stopMessage)
      console.info('[VibeTrace][trace] skip ingest — stop older than fresh window', {
        sessionID: selectedSessionId,
        stopId,
        completedMs,
        ageSec: completedMs != null ? Math.round((Date.now() - completedMs) / 1000) : null,
        windowSec: TRACE_INGEST_FRESH_WINDOW_MS / 1000,
      })
      return
    }

    const traceKey = `${selectedSessionId}:${stopId}`
    if (processedTraceTurnKeysRef.current.has(traceKey)) return
    if (traceIngestDebounceStartedRef.current.has(traceKey)) return
    if (hasTraceIngestClaim(selectedSessionId, stopId)) {
      console.info('[VibeTrace][trace] skip ingest — already processed (claim lock)', { traceKey })
      return
    }
    if (!tryClaimTraceIngest(selectedSessionId, stopId)) {
      console.info('[VibeTrace][trace] skip ingest — claim race lost', { traceKey })
      return
    }
    console.info('[VibeTrace][trace] scheduling ingest — fresh stop, claimed', {
      sessionID: selectedSessionId,
      stopId,
      windowSec: TRACE_INGEST_FRESH_WINDOW_MS / 1000,
    })

    const sid = selectedSessionId
    const endAssistantMessageId = stopId
    const timer = window.setTimeout(() => {
      traceIngestDebounceStartedRef.current.add(traceKey)
      void (async () => {
        const session = sessionsRef.current.find((s) => s.id === sid)
        const dir = session?.directory
        try {
          if (selectedSessionIdRef.current !== sid) {
            releaseTraceIngestClaim(sid, endAssistantMessageId)
            traceIngestDebounceStartedRef.current.delete(traceKey)
            return
          }
          const forkMeta = resolveForkIngestMeta(sid, sessionsRef.current)
          const maxTurns = traceSessionTurnLimit()
          console.info('[VibeTrace][trace] posting /ingest-trace reference', {
            sessionID: sid,
            endAssistantMessageId,
            maxTurns,
            forkMetaAttached: Boolean(forkMeta),
          })
          const ingestResult = await ingestTraceReference({
            sessionId: sid,
            endAssistantMessageId,
            directory: dir,
            maxTurns,
            parentSessionID: sid,
            forkMeta: forkMeta ?? undefined,
          })
          applyMemoryWorkerTaskSegments(sid, ingestResult)
          if (ingestResult.duplicate) {
            processedTraceTurnKeysRef.current.add(traceKey)
            console.info('[VibeTrace][memory-worker ingest duplicate skipped]', ingestResult)
          } else if (ingestResult.ok === false) {
            processedTraceTurnKeysRef.current.add(traceKey)
            traceIngestDebounceStartedRef.current.delete(traceKey)
            console.warn('[VibeTrace][memory-worker ingest failed]', ingestResult.error ?? ingestResult)
          } else {
            processedTraceTurnKeysRef.current.add(traceKey)
            registerMemoryWorkerInternalSessionIds(collectInternalSessionIdsFromIngest(ingestResult))
            console.info('[VibeTrace][memory-worker ingest ok]', {
              runId: ingestResult.runId,
              runDir: ingestResult.runDir,
            })
          }
        } catch (e) {
          releaseTraceIngestClaim(sid, endAssistantMessageId)
          traceIngestDebounceStartedRef.current.delete(traceKey)
          console.warn('[VibeTrace][memory-worker ingest failed]', e)
        }
      })()
    }, TRACE_EXTRACTION_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      // SSE 可能在 debounce 内再次刷新 messages；若过早标记「已处理」会导致 timer 被取消且永不 ingest
      if (!traceIngestDebounceStartedRef.current.has(traceKey)) {
        releaseTraceIngestClaim(sid, endAssistantMessageId)
      }
    }
  }, [messages, selectedSessionId, sessions, loading, applyMemoryWorkerTaskSegments])

  useEffect(() => {
    window.__vibetraceDebug = {
      getMessages: async () => {
        if (!selectedSessionIdRef.current) return []
        const sid = selectedSessionIdRef.current
        const dir = sessionsRef.current.find((s) => s.id === sid)?.directory
        const msgs = await getMessages(sid, 'window.__vibetraceDebug.getMessages()', dir)
        debugLog('[VibeTrace][manual getMessages output]', msgs)
        return msgs
      },
      latestTrace: () => latestTurnTrace,
    }
    return () => {
      delete window.__vibetraceDebug
    }
  }, [latestTurnTrace])

  // Subscribe to global SSE events
  useEffect(() => {
    const unsubscribe = subscribeGlobalEvents((event) => {
      const payload = event?.payload || event
      const eventType = payload?.type
      if (!eventType) return
      const isNoisyDelta = eventType === 'message.part.delta'
      if (!isNoisyDelta) debugLog('[VibeTrace][SSE event]', eventType, event)

      if (eventType === 'question.asked') {
        const props = payload.properties as Partial<OcPendingQuestionRequest> | undefined
        if (props?.id && props.sessionID && Array.isArray(props.questions)) {
          const root = event as { directory?: string }
          const dir = typeof root.directory === 'string' ? root.directory : undefined
          setPendingQuestions((prev) => ({
            ...prev,
            [props.sessionID!]: {
              id: props.id!,
              sessionID: props.sessionID!,
              questions: props.questions as OcPendingQuestionRequest['questions'],
              tool: props.tool,
              directory: dir,
            },
          }))
        }
      }

      if (eventType === 'question.replied' || eventType === 'question.rejected') {
        const props = payload.properties as { sessionID?: string; requestID?: string } | undefined
        if (props?.sessionID && props?.requestID) {
          setPendingQuestions((prev) => {
            const cur = prev[props.sessionID!]
            if (cur?.id === props.requestID) {
              const { [props.sessionID!]: _, ...rest } = prev
              return rest
            }
            return prev
          })
        }
      }

      if (eventType.startsWith('question')) {
        const props = payload.properties as { sessionID?: string } | undefined
        const sid = props?.sessionID
        if (sid && sid === selectedSessionIdRef.current) {
          const dir = sessionsRef.current.find((s) => s.id === sid)?.directory
          getMessages(sid, `SSE:${eventType}`, dir).then(setMessages).catch(() => {})
        }
      }

      if (eventType === 'message.part.delta') {
        // Very high-frequency token stream event; avoid fan-out REST refresh storms.
        return
      }

      if (eventType.startsWith('message') || eventType.startsWith('session')) {
        const root = event as { directory?: string }
        const eventDir = typeof root.directory === 'string' ? root.directory : undefined
        if (eventDir) sseSyncDirsRef.current.add(eventDir)
        if (sseSyncTimerRef.current !== null) return
        sseSyncTimerRef.current = window.setTimeout(() => {
          sseSyncTimerRef.current = null
          const dirs = [...sseSyncDirsRef.current]
          sseSyncDirsRef.current.clear()
          refreshSessions(dirs.length > 0 ? dirs : undefined)
            .then(setSessions)
            .catch(() => {})
          const sid = selectedSessionIdRef.current
          const dir = sessionsRef.current.find((s) => s.id === sid)?.directory
          if (sid) {
            getMessages(sid, `SSE:${eventType}`, dir).then(setMessages).catch(() => {})
          }
        }, SSE_SYNC_DEBOUNCE_MS)
      }

      if (eventType.startsWith('todo')) {
        const dir = sessionsRef.current.find(s => s.id === selectedSessionId)?.directory
        if (selectedSessionId) {
          getTodos(selectedSessionId, dir).then(setTodos).catch(() => {})
        }
      }

      if (eventType === 'session.compacted') {
        const props = payload.properties as { sessionID?: string; sessionId?: string } | undefined
        let sid = props?.sessionID ?? props?.sessionId
        if (!sid) {
          const parsed = parseActionRelatedSseEvent(event)
          sid = parsed?.sessionID
        }
        if (!sid || sid === selectedSessionIdRef.current) {
          setCompactionControlHint(
            `Context compacted · ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
          )
        }
      }
    })

    return unsubscribe
  }, [selectedSessionId, refreshSessions])

  // Load messages + todos + panel analysis when session changes
  const loadSessionData = useCallback(async (sessionId: string, directory?: string) => {
    if (!sessionId) return
    setLoading(true)
    try {
      const [msgs, td, panelBatch] = await Promise.all([
        getMessages(sessionId, 'initial load / session switch', directory),
        getTodos(sessionId, directory),
        fetchPanelAnalysisForSession(sessionId).catch((err) => {
          console.warn('[VibeTrace][panel-analysis] worker hydrate failed', { sessionId, err })
          return { ok: false, count: 0, items: [] as MemoryWorkerErrorDiagnosis[] }
        }),
      ])
      if (selectedSessionIdRef.current !== sessionId) return
      setMessages(msgs)
      setTodos(td)
      if (panelBatch.items?.length) {
        mergePanelAnalysisItems(sessionId, panelBatch.items)
        console.info('[VibeTrace][panel-analysis] hydrated from worker', {
          sessionId,
          count: panelBatch.items.length,
        })
      }
    } catch {
      /* loading errors surface via empty state; avoid noisy console */
    } finally {
      setLoading(false)
    }
  }, [mergePanelAnalysisItems])

  useEffect(() => {
    void loadSessionData(selectedSessionId, activeSessionDirectory)
  }, [selectedSessionId, activeSessionDirectory, loadSessionData])

  /** Auto-abort when a tool stays running/pending >24h without a follow-up assistant message (once per call id). */
  useEffect(() => {
    if (!selectedSessionId || aborting) return
    const now = Date.now()
    let stuckCallId: string | undefined
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg || msg.info.role !== 'assistant') continue
      const hasLaterAssistant = messages.slice(i + 1).some((m) => m?.info.role === 'assistant')
      if (hasLaterAssistant) continue
      for (const p of msg.parts) {
        if (p.type !== 'tool') continue
        const st = p.state?.status
        if (st !== 'running' && st !== 'pending') continue
        const start = p.state?.time?.start ?? msg.info.time?.created
        if (typeof start !== 'number' || !Number.isFinite(start)) continue
        if (now - start < AUTO_ABORT_STUCK_RUNNING_AFTER_MS) continue
        stuckCallId = p.callID
        break
      }
      if (stuckCallId) break
    }
    if (!stuckCallId) return

    const runKey = `${selectedSessionId}:${stuckCallId}`
    if (autoAbortedRunningKeysRef.current.has(runKey)) return
    autoAbortedRunningKeysRef.current.add(runKey)

    const dir = sessionsRef.current.find((s) => s.id === selectedSessionId)?.directory
    setAborting(true)
    void (async () => {
      try {
        await abortSession(selectedSessionId, dir)
        const [list, msgs] = await Promise.all([
          refreshSessions(),
          getMessages(selectedSessionId, 'auto abort stuck running >24h', dir),
        ])
        setSessions(list)
        setMessages(msgs)
      } catch {
        autoAbortedRunningKeysRef.current.delete(runKey)
      } finally {
        setAborting(false)
      }
    })()
  }, [messages, selectedSessionId, aborting, refreshSessions])

  useEffect(() => {
    setTodosSnapshotAtMessageIndex({})
  }, [selectedSessionId])

  // Snapshot todos at the latest todo-write message for completed-item diffs during regrouping
  useEffect(() => {
    if (!selectedSessionId || loading) return
    const writeIdxs: number[] = []
    messages.forEach((m, i) => {
      if (isTodoWriteMessage(m)) writeIdxs.push(i)
    })
    if (writeIdxs.length === 0) return
    const lastWrite = writeIdxs[writeIdxs.length - 1]!
    const key = String(lastWrite)
    setTodosSnapshotAtMessageIndex(prev => ({
      ...prev,
      [key]: todos.map(t => ({ ...t })),
    }))
  }, [messages, todos, selectedSessionId, loading])

  const sessionTodoModel = useMemo(
    () => buildSessionTodoModel(messages, todos, todosSnapshotAtMessageIndex),
    [messages, todos, todosSnapshotAtMessageIndex],
  )

  const archivedForPanel = useMemo(
    () => archivedCompletedList(sessionTodoModel.completedArchive),
    [sessionTodoModel.completedArchive],
  )

  const latestTodowriteBatchProgress = useMemo(
    () => getLatestTodowriteBatchProgress(sessionTodoModel, archivedForPanel),
    [sessionTodoModel, archivedForPanel],
  )

  const assistantSubtasks = useMemo(() => {
    const fb =
      sessionTodoModel.latestActive.length > 0 ? sessionTodoModel.latestActive : todos
    return groupAssistantSubtasks(messages, {
      canonicalTodosAtMessageIndex(i) {
        const c = sessionTodoModel.canonicalAtMessageIndex.get(i)
        return c !== undefined && c.length > 0 ? c : undefined
      },
      todosAfterMessageIndex(i) {
        const snap = todosSnapshotAtMessageIndex[String(i)]
        return snap !== undefined ? snap : undefined
      },
      fallbackSessionTodos: fb,
    })
  }, [messages, todosSnapshotAtMessageIndex, todos, sessionTodoModel])

  /**
   * Right-rail cards mirror `groupAssistantSubtasks`, including planning segments before the first todowrite.
   */
  const visibleSubtasks = useMemo(
    () => assistantSubtasks.map((subtask, sourceIndex) => ({ subtask, sourceIndex })),
    [assistantSubtasks],
  )

  const taskSegmentsForActiveSession = useMemo(() => {
    if (!selectedSessionId) return []
    const tabs = taskSegmentsBySessionId[selectedSessionId] ?? []
    return [...tabs].sort((a, b) => {
      const ai = messages.findIndex((m) => m.info.id === a.fromStartUserMessageId)
      const bi = messages.findIndex((m) => m.info.id === b.fromStartUserMessageId)
      if (ai !== bi) return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
      return a.id.localeCompare(b.id)
    })
  }, [messages, selectedSessionId, taskSegmentsBySessionId])

  const activeTaskSegmentId = selectedSessionId ? activeTaskSegmentBySessionId[selectedSessionId] : undefined
  const activeTaskSegment = useMemo(() => {
    if (!activeTaskSegmentId) return null
    return taskSegmentsForActiveSession.find((tab) => tab.id === activeTaskSegmentId) ?? null
  }, [activeTaskSegmentId, taskSegmentsForActiveSession])

  useEffect(() => {
    if (!selectedSessionId || taskSegmentsForActiveSession.length === 0) return
    if (activeTaskSegmentId && taskSegmentsForActiveSession.some((tab) => tab.id === activeTaskSegmentId)) return
    const latest = taskSegmentsForActiveSession[taskSegmentsForActiveSession.length - 1]
    if (latest) {
      setActiveTaskSegmentBySessionId((prev) => ({ ...prev, [selectedSessionId]: latest.id }))
    }
  }, [activeTaskSegmentId, selectedSessionId, taskSegmentsForActiveSession])

  const visibleSubtasksForTaskSegment = useMemo(() => {
    if (!activeTaskSegment) return visibleSubtasks
    const startIndex = messages.findIndex((m) => m.info.id === activeTaskSegment.fromStartUserMessageId)
    if (startIndex < 0) return visibleSubtasks
    const endIndex =
      activeTaskSegment.status === 'pending'
        ? Number.POSITIVE_INFINITY
        : messages.findIndex((m) => m.info.id === activeTaskSegment.toEndAssistantMessageId)
    if (endIndex < 0) return visibleSubtasks
    return visibleSubtasks.filter(({ subtask }) => {
      const indices = [...(subtask.userMessageIndices ?? []), ...(subtask.assistantMessageIndices ?? [])]
      return indices.some((idx) => idx >= startIndex && idx <= endIndex)
    })
  }, [activeTaskSegment, messages, visibleSubtasks])

  /** Execution-phase cards: highlight Todo rows via linked ids */
  const linkedTodoIds = useMemo(() => {
    if (linkedSubtaskIndex === null) return null
    const st = assistantSubtasks[linkedSubtaskIndex]
    if (!st || !subtaskShouldUseTodoLink(st)) return null
    return new Set(st.linkedTodoIds)
  }, [linkedSubtaskIndex, assistantSubtasks])

  /** Parent message index for scroll-to when an action glyph is selected in the flow. */
  const linkedMessageIndexForConnector = useMemo(() => {
    if (!selection) return null
    const mid = actionKeyMessageId(selection.actionKey)
    if (!mid) return null
    const idx = messages.findIndex((m) => m.info.id === mid)
    return idx >= 0 ? idx : null
  }, [selection, messages])

  const linkedMessageToAction = useMemo(() => {
    if (linkedSubtaskIndex === null || selection === null) return null
    if (selection.subtaskIndex !== linkedSubtaskIndex) return null
    const mi = linkedMessageIndexForConnector
    if (mi === null) return null
    return {
      messageIndex: mi,
      actionKey: selection.actionKey,
      subtaskIndex: selection.subtaskIndex,
    }
  }, [linkedSubtaskIndex, selection, linkedMessageIndexForConnector])

  /** Planning / no linked todo ids: same message→flow geometry as selection, anchored on first segment action */
  const noTodoAnchor = useMemo(() => {
    if (linkedSubtaskIndex === null) return null
    const st = assistantSubtasks[linkedSubtaskIndex]
    if (!st || subtaskShouldUseTodoLink(st)) return null
    const actionKey = firstFlowAnchorKeyForSubtaskSegment(st, messages, Date.now())
    if (!actionKey) return null
    const mid = actionKeyMessageId(actionKey)
    if (!mid) return null
    const messageIndex = messages.findIndex((m) => m.info.id === mid)
    if (messageIndex < 0) return null
    return { messageIndex, actionKey }
  }, [linkedSubtaskIndex, assistantSubtasks, messages])

  const toggleSubtaskLink = useCallback((si: number) => {
    setLinkedSubtaskIndex((prev) => {
      const next = prev === si ? null : si
      setSelection((sel) => {
        if (!sel) return null
        if (next === null || sel.subtaskIndex !== next) return null
        return sel
      })
      return next
    })
  }, [])

  const handleTodoClick = useCallback(
    (todo: OcTodo) => {
      const preferred = findSubtaskIndexForTodo(assistantSubtasks, todo)
      if (
        preferred !== null &&
        subtaskShouldUseTodoLink(assistantSubtasks[preferred]!)
      ) {
        setLinkedSubtaskIndex(preferred)
        return
      }
      const id = todo.id?.trim()
      if (!id) return
      const fallback = visibleSubtasksForTaskSegment.find(({ subtask }) =>
        subtask.linkedTodoIds.includes(id)
      )
      if (fallback) setLinkedSubtaskIndex(fallback.sourceIndex)
    },
    [assistantSubtasks, visibleSubtasksForTaskSegment]
  )

  useEffect(() => {
    if (!compactionControlHint) return
    const id = window.setTimeout(() => setCompactionControlHint(null), 8000)
    return () => window.clearTimeout(id)
  }, [compactionControlHint])

  useEffect(() => {
    setCompactionControlHint(null)
    setLinkedSubtaskIndex(null)
    setTodoPanelRevealGeneration(0)
    setSelection(null)
  }, [selectedSessionId])

  useEffect(() => {
    setLinkedSubtaskIndex(null)
    setSelection(null)
  }, [activeTaskSegmentId])

  useEffect(() => {
    if (linkedSubtaskIndex !== null) {
      setTodoPanelRevealGeneration(g => g + 1)
    }
  }, [linkedSubtaskIndex])

  useEffect(() => {
    if (linkedSubtaskIndex !== null && linkedSubtaskIndex >= assistantSubtasks.length) {
      setLinkedSubtaskIndex(null)
    }
  }, [linkedSubtaskIndex, assistantSubtasks.length])

  useEffect(() => {
    if (linkedSubtaskIndex === null) return
    if (visibleSubtasksForTaskSegment.some(({ sourceIndex }) => sourceIndex === linkedSubtaskIndex)) return
    setLinkedSubtaskIndex(null)
    setSelection(null)
  }, [linkedSubtaskIndex, visibleSubtasksForTaskSegment])

  useEffect(() => {
    if (linkedTodoIds && linkedTodoIds.size > 0) {
      let inner = 0
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          const scroll = todoPanelScrollRef.current
          if (!scroll) return
          for (const el of scroll.querySelectorAll('[data-todo-link-id]')) {
            const k = el.getAttribute('data-todo-link-id')?.trim() ?? ''
            if (k && linkedTodoIds.has(k)) {
              el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
              break
            }
          }
        })
      })
      return () => {
        cancelAnimationFrame(outer)
        cancelAnimationFrame(inner)
      }
    }
  }, [linkedSubtaskIndex, linkedTodoIds, todoPanelRevealGeneration])

  useEffect(() => {
    if (linkedSubtaskIndex === null) return
    const mid = linkedMessageIndexForConnector
    const selMatches =
      selection !== null &&
      selection.subtaskIndex === linkedSubtaskIndex &&
      mid !== null
    requestAnimationFrame(() => {
      const scrollRoot = messageScrollRef.current
      if (!scrollRoot) return
      if (selMatches && mid !== null) {
        scrollRoot
          .querySelector(`[data-message-index="${mid}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        return
      }
      const st = assistantSubtasks[linkedSubtaskIndex]
      if (!st || st.assistantMessageIndices.length === 0) return

      const noTodoConnector =
        linkedTodoIds === null || linkedTodoIds.size === 0

      if (noTodoConnector) {
        const anchorKey = firstFlowAnchorKeyForSubtaskSegment(st, messages, Date.now())
        if (anchorKey) {
          const esc =
            typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
              ? CSS.escape(anchorKey)
              : anchorKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
          const anchorEl = scrollRoot.querySelector(`[data-transcript-action-key="${esc}"]`)
          if (anchorEl) {
            anchorEl.scrollIntoView({ block: 'center', behavior: 'smooth' })
            return
          }
        }
      }

      const first = Math.min(...st.assistantMessageIndices)
      scrollRoot
        .querySelector(`[data-message-index="${first}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }, [
    linkedSubtaskIndex,
    assistantSubtasks,
    linkedMessageIndexForConnector,
    selection,
    linkedTodoIds,
    messages,
  ])

  useEffect(() => {
    if (linkedSubtaskIndex === null) return
    requestAnimationFrame(() => {
      subtaskScrollRef.current
        ?.querySelector(`[data-subtask-card-index="${linkedSubtaskIndex}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }, [linkedSubtaskIndex])

  const handleSessionTitleCommit = useCallback(
    async (title: string) => {
      if (!selectedSessionId) return
      const dir = sessions.find(s => s.id === selectedSessionId)?.directory
      await updateSessionTitle(selectedSessionId, title, dir)
      const list = await refreshSessions()
      setSessions(list)
    },
    [selectedSessionId, sessions, refreshSessions],
  )

  const handleQuestionReply = useCallback(async (answers: string[][]) => {
    const pq = pendingQuestionsRef.current[selectedSessionId]
    if (!pq) return
    setQuestionSubmitting(true)
    try {
      await replyToQuestion(pq.id, answers, pq.directory)
      setPendingQuestions((prev) => {
        const { [pq.sessionID]: _, ...rest } = prev
        return rest
      })
      const dir = sessionsRef.current.find((s) => s.id === selectedSessionId)?.directory
      const msgs = await getMessages(selectedSessionId, 'after question reply', dir)
      setMessages(msgs)
    } catch {
      window.alert(
        'Failed to submit answers. Ensure OpenCode exposes POST /question/{requestID}/reply (OpenCode SDK v2 / recent opencode serve).',
      )
    } finally {
      setQuestionSubmitting(false)
    }
  }, [selectedSessionId])

  const handleQuestionReject = useCallback(async () => {
    const pq = pendingQuestionsRef.current[selectedSessionId]
    if (!pq) return
    setQuestionSubmitting(true)
    try {
      await rejectQuestion(pq.id, pq.directory)
      setPendingQuestions((prev) => {
        const { [pq.sessionID]: _, ...rest } = prev
        return rest
      })
      const dir = sessionsRef.current.find((s) => s.id === selectedSessionId)?.directory
      const msgs = await getMessages(selectedSessionId, 'after question reject', dir)
      setMessages(msgs)
    } catch {
      window.alert('Action failed.')
    } finally {
      setQuestionSubmitting(false)
    }
  }, [selectedSessionId])

  /** Inline question answered in a bubble: mirror bottom panel refresh + clear SSE pending bucket */
  const handleQuestionAnswered = useCallback(async () => {
    if (!selectedSessionId) return
    const dir = sessionsRef.current.find((s) => s.id === selectedSessionId)?.directory
    try {
      const msgs = await getMessages(selectedSessionId, 'after inline question submit', dir)
      setMessages(msgs)
    } catch {
      /* transcript refresh best-effort */
    }
    setPendingQuestions((prev) => {
      const next = { ...prev }
      delete next[selectedSessionId]
      return next
    })
  }, [selectedSessionId])

  const handleSendMessage = useCallback(async (payload: MessageSendPayload) => {
    if (!selectedSessionId) return
    const dir = sessions.find(s => s.id === selectedSessionId)?.directory
    const sid = selectedSessionId
    const text = buildUserMessageWithGuidance(payload.combinedText)
    const images = payload.imageParts
    const rawUserPrompt = payload.combinedText.trim()
    // OpenCode often finishes POST /message only after the agent turn — awaiting here would keep the composer disabled.
    // Fire-and-forget like fork’s first message: rely on SSE + a follow-up GET /message poll.
    void (async () => {
      try {
        void notifyTaskSwitchPrompt({
          sessionId: sid,
          userPrompt: rawUserPrompt,
          directory: dir,
          parentSessionID: sid,
          forkMeta: resolveForkIngestMeta(sid, sessionsRef.current) ?? undefined,
        })
          .then((result) => applyMemoryWorkerTaskSegments(sid, result))
          .catch((e) => console.warn('[VibeTrace][task-switch prompt failed]', e))
        await sendMessage(sid, text, dir, { imageParts: images, model: composerModelRef.trim() || undefined })
        const msgs = await getMessages(sid, 'after POST /message completes', dir)
        setMessages(msgs)
        const last = msgs[msgs.length - 1]
        if (last?.info.role === 'user') {
          setWaitingForAssistantReply(true)
          try {
            await pollUntilAssistantMessage(sid, dir, () => selectedSessionIdRef.current === sid, setMessages)
          } finally {
            setWaitingForAssistantReply(false)
          }
        }
      } catch (e) {
        window.alert(`Send failed: ${e instanceof Error ? e.message : String(e)}`)
        setWaitingForAssistantReply(false)
      }
    })()
  }, [selectedSessionId, sessions, composerModelRef, applyMemoryWorkerTaskSegments])

  const handleAbortMessage = useCallback(async () => {
    if (!selectedSessionId) return
    const dir = sessions.find(s => s.id === selectedSessionId)?.directory
    setAborting(true)
    try {
      await abortSession(selectedSessionId, dir)
      const [list, msgs] = await Promise.all([
        refreshSessions(),
        getMessages(selectedSessionId, 'after abort refresh', dir),
      ])
      setSessions(list)
      setMessages(msgs)
    } finally {
      setAborting(false)
    }
  }, [selectedSessionId, sessions, refreshSessions])

  const selectedSession = sessions.find(s => s.id === selectedSessionId)

  const handleSelectDirectory = useCallback(
    async (dir: string) => {
      setSelectedDirectory(dir)
      setSelectedSessionId('')
      setMessages([])
      setTodos([])
      setTodosSnapshotAtMessageIndex({})

      const currentInFolder = sessions
        .filter(s => sameDirectory(s.directory, dir))
        .sort((a, b) => b.time.updated - a.time.updated)
      if (currentInFolder.length > 0) {
        setSelectedSessionId(currentInFolder[0]!.id)
        return
      }

      const list = await refreshSessions([dir])
      const refreshedInFolder = list
        .filter(s => sameDirectory(s.directory, dir))
        .sort((a, b) => b.time.updated - a.time.updated)
      if (refreshedInFolder.length > 0) {
        setSelectedSessionId(refreshedInFolder[0]!.id)
      }
    },
    [sessions, refreshSessions],
  )

  const handleCreateSession = useCallback(async () => {
    setCreatingSession(true)
    try {
      const dir = selectedDirectory || undefined
      const created = await createSession(dir)
      const list = await refreshSessions([created.directory])
      setSessions(list)
      setApiConnected(true)
      setSelectedDirectory(normalizeSessionDirectory(created.directory))
      setSelectedSessionId(created.id)
    } catch {
      setApiConnected(false)
    } finally {
      setCreatingSession(false)
    }
  }, [selectedDirectory, refreshSessions])

  const handleAddDirectory = useCallback(async () => {
    const dir = promptDirectoryPath(selectedDirectory || '')
    if (!dir) return
    setManualDirectories((prev) => (prev.includes(dir) ? prev : [...prev, dir]))
    setClosedDirectories((prev) => prev.filter((d) => d !== dir))
    setSelectedDirectory(dir)
    setSelectedSessionId('')
    setMessages([])
    setTodos([])
    setTodosSnapshotAtMessageIndex({})
    const list = await refreshSessions([dir])
    const inFolder = list
      .filter(s => sameDirectory(s.directory, dir))
      .sort((a, b) => b.time.updated - a.time.updated)
    if (inFolder.length > 0) {
      setSelectedSessionId(inFolder[0]!.id)
    }
  }, [selectedDirectory, refreshSessions])

  const handleCloseDirectory = useCallback(
    (dir: string) => {
      const normalized = normalizeSessionDirectory(dir)
      if (!normalized) return
      setClosedDirectories((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]))
      if (sameDirectory(selectedDirectory, normalized)) {
        setSelectedDirectory('')
        setSelectedSessionId('')
        setMessages([])
        setTodos([])
        setTodosSnapshotAtMessageIndex({})
      }
      void refreshSessions()
    },
    [selectedDirectory, refreshSessions],
  )

  const handleArchiveSession = useCallback(
    async (sessionId: string) => {
      const s = sessions.find((x) => x.id === sessionId)
      const label = (s?.title || 'Untitled').slice(0, 80)
      if (
        !window.confirm(
          `Delete session "${label}"?\n\nThis calls OpenCode DELETE /session/:id and removes the conversation from the server. This usually cannot be undone.`,
        )
      ) {
        return
      }
      const dir = s?.directory
      setArchivingSessionId(sessionId)
      try {
        await deleteSession(sessionId, dir)
        setPendingQuestions((prev) => {
          const { [sessionId]: _, ...rest } = prev
          return rest
        })
        const list = await refreshSessions()
        setSessions(list)
        setApiConnected(true)
        if (list.length === 0) {
          setSelectedSessionId('')
          setMessages([])
          setTodos([])
          setTodosSnapshotAtMessageIndex({})
        } else if (selectedSessionId === sessionId) {
          setMessages([])
          setTodos([])
          setTodosSnapshotAtMessageIndex({})
        }
      } catch (e) {
        window.alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setArchivingSessionId(null)
      }
    },
    [sessions, selectedSessionId, refreshSessions],
  )

  const handleForkFromAction = useCallback(
    (action: MappedAction & { row: number }, forkCtx?: ForkFromActionContext) => {
      const targetSessionId = action.sessionID || selectedSessionId
      if (!targetSessionId || !action.messageID) return
      setPendingFork({ action, forkCtx })
    },
    [selectedSessionId],
  )

  const handleConfirmForkWithPrompt = useCallback(
    async (forkPrompt: string) => {
      const pending = pendingForkRef.current
      if (!pending) return
      const { action } = pending
      const targetSessionId = action.sessionID || selectedSessionId
      if (!targetSessionId || !action.messageID) {
        setPendingFork(null)
        return
      }
      const dir = sessions.find((s) => s.id === targetSessionId)?.directory ?? activeSessionDirectory
      const tabsSourceId = resolveTaskTabsSourceSessionId(
        taskSegmentsBySessionId,
        selectedSessionId ?? undefined,
        targetSessionId,
      )
      const inheritedTabs = tabsSourceId
        ? cloneTaskSegmentTabs(taskSegmentsBySessionId[tabsSourceId] ?? [])
        : []
      const inheritedActiveTabId = tabsSourceId ? activeTaskSegmentBySessionId[tabsSourceId] : undefined
      const inheritedManualSelection = tabsSourceId
        ? Boolean(taskSegmentManuallySelectedBySessionId[tabsSourceId])
        : false

      setForkBusy(true)
      try {
        const { forkCtx } = pending
        let bundle: ForkPanelSnapshotBundle | null = null
        if (forkCtx) {
          try {
            bundle = await buildForkPanelSnapshotBundle({
              messages,
              visibleSubtasks,
              sessionDirectory: dir,
              forkAnchorMessageId: action.messageID,
              forkAnchorPartId: action.partId,
              sourceParentSessionId: targetSessionId,
              forkCtx,
            })
          } catch {
            /* snapshot optional */
          }
        }

        const forked = await forkSession(targetSessionId, {
          messageID: action.messageID,
          directory: dir,
        })
        if (bundle) {
          saveForkPanelSnapshotBundle(forked.id, bundle)
        }

        if (inheritedTabs.length > 0) {
          setTaskSegmentsBySessionId((prev) => ({
            ...prev,
            [forked.id]: inheritedTabs,
          }))
          if (inheritedActiveTabId) {
            setActiveTaskSegmentBySessionId((prev) => ({
              ...prev,
              [forked.id]: inheritedActiveTabId,
            }))
          }
          if (inheritedManualSelection) {
            setTaskSegmentManuallySelectedBySessionId((prev) => ({
              ...prev,
              [forked.id]: true,
            }))
          }
          console.info('[VibeTrace][fork inherited task tabs]', {
            forkedSessionId: forked.id,
            sourceSessionId: tabsSourceId,
            tabCount: inheritedTabs.length,
            activeTabId: inheritedActiveTabId,
          })
        }

        const forkMetaForWorker = {
          forkAnchorMessageId: action.messageID,
          sourceParentSessionId: targetSessionId,
          forkedSessionId: forked.id,
          ...(action.partId ? { forkAnchorPartId: action.partId } : {}),
        }
        void inheritForkTaskState({
          sessionId: forked.id,
          sourceParentSessionId: targetSessionId,
          directory: forked.directory,
        }).catch((err) => console.warn('[VibeTrace][fork inherit task-switch state failed]', err))

        const list = await refreshSessions([forked.directory])
        setSessions(list)
        setApiConnected(true)
        setSelectedDirectory(normalizeSessionDirectory(forked.directory))
        setSelectedSessionId(forked.id)
        const [msgs, td] = await Promise.all([
          getMessages(forked.id, 'after fork load session', forked.directory),
          getTodos(forked.id, forked.directory),
        ])
        setMessages(msgs)
        setTodos(td)

        const userText = forkPrompt.trim()
        if (userText.length > 0) {
          const guidedUserText = buildUserMessageWithGuidance(userText)
          // POST /message may return only after the agent turn; don’t block the composer on it.
          void (async () => {
            try {
              void notifyTaskSwitchPrompt({
                sessionId: forked.id,
                userPrompt: userText,
                directory: forked.directory,
                parentSessionID: forked.id,
                forkMeta: forkMetaForWorker,
              })
                .then((result) => applyMemoryWorkerTaskSegments(forked.id, result))
                .catch((err) => console.warn('[VibeTrace][fork task-switch prompt failed]', err))
              await sendMessage(forked.id, guidedUserText, forked.directory, {
                model: composerModelRef.trim() || undefined,
              })
              const msgsAfterSend = await getMessages(
                forked.id,
                'after fork first user message',
                forked.directory,
              )
              setMessages(msgsAfterSend)
              const lastFork = msgsAfterSend[msgsAfterSend.length - 1]
              if (lastFork?.info.role === 'user') {
                setWaitingForAssistantReply(true)
                try {
                  await pollUntilAssistantMessage(
                    forked.id,
                    forked.directory,
                    () => selectedSessionIdRef.current === forked.id,
                    setMessages,
                  )
                } finally {
                  setWaitingForAssistantReply(false)
                }
              }
            } catch (err) {
              window.alert(
                `Failed to send the first message after fork: ${err instanceof Error ? err.message : String(err)}\n\nCheck that OpenCode is running, VITE_OPENCODE_BASE matches your terminal, and POST …/message returns 200 in the Network tab.`,
              )
            }
          })()
        }
        setPendingFork(null)
        setForkBusy(false)
      } catch {
        setPendingFork(null)
      } finally {
        setForkBusy(false)
      }
    },
    [selectedSessionId, sessions, activeSessionDirectory, messages, visibleSubtasks, refreshSessions, composerModelRef, applyMemoryWorkerTaskSegments, taskSegmentsBySessionId, activeTaskSegmentBySessionId, taskSegmentManuallySelectedBySessionId],
  )

  const handleAnalyzeFromAction = useCallback((action: MappedAction & { row: number }) => {
    setAnalysisAction(action)
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        background: '#F8F8F8',
        position: 'relative',
      }}
    >
      {/* Sidebar: workspaces + sessions */}
      <Sidebar
        sessionsInFolder={sessionsInFolder}
        directories={directories}
        selectedDirectory={selectedDirectory}
        onSelectDirectory={handleSelectDirectory}
        selectedSessionId={selectedSessionId}
        onSelectSession={handleSelectSession}
        onCreateSession={handleCreateSession}
        creatingSession={creatingSession}
        onArchiveSession={handleArchiveSession}
        archivingSessionId={archivingSessionId}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        apiConnected={apiConnected}
        onAddDirectory={handleAddDirectory}
        onCloseDirectory={handleCloseDirectory}
      />

      {/* Center + right columns share one positioned parent for connector lines */}
      <div
        ref={linkAreaRef}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'row',
          position: 'relative',
          cursor: isResizingSubtaskPanel ? 'col-resize' : undefined,
        }}
      >
        <div
          style={{
            flex: '1 1 auto',
            minWidth: MESSAGE_PANEL_MIN_WIDTH,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              width: '100%',
              minHeight: 0,
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <MessagePanel
              messages={messages}
              latestTodos={sessionTodoModel.latestActive}
              archivedTodos={archivedForPanel}
              latestTodowriteBatchProgress={latestTodowriteBatchProgress}
              loading={loading}
              waitingForAssistantReply={waitingForAssistantReply}
              sessionId={selectedSessionId}
              sessionTitle={selectedSession?.title}
              onRefresh={() => loadSessionData(selectedSessionId, activeSessionDirectory)}
              onSendMessage={handleSendMessage}
              onAbortMessage={handleAbortMessage}
              aborting={aborting}
              messageListScrollRef={messageScrollRef}
              todoPanelScrollRef={todoPanelScrollRef}
              highlightMessageIndices={null}
              highlightTodoIds={linkedTodoIds}
              todoPanelRevealGeneration={todoPanelRevealGeneration}
              onTodoClick={handleTodoClick}
              onSessionTitleCommit={handleSessionTitleCommit}
              pendingQuestion={
                selectedSessionId ? pendingQuestions[selectedSessionId] ?? null : null
              }
              onQuestionReply={handleQuestionReply}
              onQuestionReject={handleQuestionReject}
              questionSubmitting={questionSubmitting}
              sessionDirectory={activeSessionDirectory}
              onQuestionAnswered={handleQuestionAnswered}
              composerModelRef={composerModelRef}
              onComposerModelRefChange={handleComposerModelRefChange}
              composerModelOptions={composerModelOptionsForUi}
              composerModelsLoading={composerModelsLoading}
              composerModelsError={composerModelsError}
              envBootstrapModel={envBootstrapModel}
            />
          </div>
        </div>

        <div
          role="separator"
          aria-label="Resize VibeTrace panel"
          aria-orientation="vertical"
          title="Drag to resize VibeTrace panel"
          onPointerDown={handleSubtaskPanelResizePointerDown}
          style={{
            flex: '0 0 8px',
            width: 8,
            cursor: 'col-resize',
            position: 'relative',
            zIndex: 4,
            touchAction: 'none',
            background: isResizingSubtaskPanel ? '#EEF3FF' : 'transparent',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 3,
              width: 1,
              background: isResizingSubtaskPanel ? '#5A8FFF' : '#E1E1E1',
            }}
          />
        </div>

        <div
          style={{
            width: subtaskPanelWidth,
            flex: `0 0 ${subtaskPanelWidth}px`,
            minWidth: 0,
            background: '#FFFFFF',
            display: 'flex',
            flexDirection: 'column',
            transition: isResizingSubtaskPanel ? 'none' : 'width 0.15s ease',
          }}
        >
          <div
            style={{
              height: 48,
              padding: '0 14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: '1px solid #E8E8E8',
              fontSize: 12,
              fontWeight: 500,
              color: '#171717',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <span style={{ flexShrink: 0 }}>VibeTrace</span>
              {compactionControlHint ? (
                <span
                  title="OpenCode SSE: session.compacted — context window was compacted"
                  style={{
                    fontSize: 10,
                    fontWeight: 500,
                    color: '#467FA8',
                    flexShrink: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {compactionControlHint}
                </span>
              ) : null}
              {SHOW_COMPOSER_MODEL_UI && (
              <span
                title="与左侧输入框「模型」选择同步"
                style={{
                  fontSize: 11,
                  fontWeight: 400,
                  color: '#737373',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {composerModelRef.trim()
                  ? `模型 ${composerModelRef.trim()}`
                  : envBootstrapModel
                    ? `模型 ${envBootstrapModel}（.env）`
                    : '模型：服务端默认'}
              </span>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setSubtaskFlowLayoutMode('timeline')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    fontSize: 11,
                    lineHeight: '16px',
                    color: subtaskFlowLayoutMode === 'timeline' ? '#2B2B2B' : '#A3A3A3',
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 3,
                      boxSizing: 'border-box',
                      background: subtaskFlowLayoutMode === 'timeline' ? '#C6C6C6' : 'transparent',
                      border:
                        subtaskFlowLayoutMode === 'timeline'
                          ? '1px solid #8A8A8A'
                          : '1px solid #C6C6C6',
                    }}
                  />
                  timeline
                </button>
                <button
                  type="button"
                  onClick={() => setSubtaskFlowLayoutMode('summary')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    fontSize: 11,
                    lineHeight: '16px',
                    color: subtaskFlowLayoutMode === 'summary' ? '#2B2B2B' : '#A3A3A3',
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 3,
                      boxSizing: 'border-box',
                      background: subtaskFlowLayoutMode === 'summary' ? '#C6C6C6' : 'transparent',
                      border:
                        subtaskFlowLayoutMode === 'summary'
                          ? '1px solid #8A8A8A'
                          : '1px solid #C6C6C6',
                    }}
                  />
                  summary
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                onClick={() => setSubtaskFullscreenOpen(true)}
                aria-label="Open VibeTrace fullscreen"
                title="Open VibeTrace fullscreen"
                disabled={visibleSubtasksForTaskSegment.length === 0}
                style={{
                  width: 26,
                  height: 26,
                  border: 'none',
                  background: 'transparent',
                  cursor: visibleSubtasksForTaskSegment.length === 0 ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 6,
                  color: visibleSubtasksForTaskSegment.length === 0 ? '#C6C6C6' : '#5C5C5C',
                }}
                onMouseEnter={(e) => {
                  if (visibleSubtasksForTaskSegment.length === 0) return
                  e.currentTarget.style.background = '#F3F3F3'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9V3h6" />
                  <path d="M21 9V3h-6" />
                  <path d="M3 15v6h6" />
                  <path d="M21 15v6h-6" />
                </svg>
              </button>
            </div>
          </div>
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              minWidth: 0,
              padding: '12px 14px 0',
              gap: 0,
            }}
          >
            <SubtaskDebugPanel
              messages={messages}
              visibleSubtasks={visibleSubtasksForTaskSegment}
              linkedSubtaskIndex={linkedSubtaskIndex}
              onSelectSubtask={toggleSubtaskLink}
              onForkFromAction={handleForkFromAction}
              onAnalyzeFromAction={handleAnalyzeFromAction}
              listScrollRef={subtaskScrollRef}
              sessionDirectory={activeSessionDirectory}
              forkPanelSnapshotBundle={forkPanelSnapshotBundle}
              flowLayoutMode={subtaskFlowLayoutMode}
              selection={selection}
              onSelectAction={handleSelectAction}
              taskTabs={taskSegmentsForActiveSession}
              activeTaskTabId={activeTaskSegmentId}
              sessionId={selectedSessionId}
              errorDiagnosisBySubtaskId={errorDiagnosisBySubtaskId}
              onSelectTaskTab={
                selectedSessionId
                  ? (id) => handleSelectTaskSegment(selectedSessionId, id)
                  : undefined
              }
            />
          </div>
        </div>

        <ForkSessionModal
          open={pendingFork !== null}
          submitting={forkBusy}
          onClose={() => {
            if (!forkBusy) setPendingFork(null)
          }}
          onConfirm={handleConfirmForkWithPrompt}
        />

        <SubtaskMessageConnector
          containerRef={linkAreaRef}
          messageScrollRef={messageScrollRef}
          todoPanelScrollRef={todoPanelScrollRef}
          subtaskScrollRef={subtaskScrollRef}
          subtaskIndex={linkedSubtaskIndex}
          linkedTodoIds={linkedTodoIds}
          linkedMessageToAction={linkedMessageToAction}
          noTodoAnchor={noTodoAnchor}
        />
        {analysisAction ? (
          <ActionAnalysisModal action={analysisAction} onClose={() => setAnalysisAction(null)} />
        ) : null}

        <FullscreenSubtaskPanel
          open={subtaskFullscreenOpen}
          onClose={() => setSubtaskFullscreenOpen(false)}
          messages={messages}
          visibleSubtasks={visibleSubtasksForTaskSegment}
          linkedSubtaskIndex={linkedSubtaskIndex}
          onSelectSubtask={toggleSubtaskLink}
          onForkFromAction={handleForkFromAction}
          onAnalyzeFromAction={handleAnalyzeFromAction}
          sessionDirectory={activeSessionDirectory}
          forkPanelSnapshotBundle={forkPanelSnapshotBundle}
          flowLayoutMode={subtaskFlowLayoutMode}
          selection={selection}
          onSelectAction={handleSelectAction}
          taskTabs={taskSegmentsForActiveSession}
          activeTaskTabId={activeTaskSegmentId}
          sessionId={selectedSessionId}
          errorDiagnosisBySubtaskId={errorDiagnosisBySubtaskId}
          onSelectTaskTab={
            selectedSessionId
              ? (id) => handleSelectTaskSegment(selectedSessionId, id)
              : undefined
          }
        />
      </div>
    </div>
  )
}

export default App
