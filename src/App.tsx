import { useState, useEffect, useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { OcSession } from './types/opencode'
import {
  getCurrentWorkspaceDirectory,
  getProjectDirectories,
  getSessions,
  getSessionsForDirectory,
  OPENCODE_SESSION_DIRECTORY_LIMIT,
  OPENCODE_SESSION_RECENT_LIMIT,
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
  getPendingPermissions,
  replyToPermission,
  normalizePermissionRequest,
  subscribeGlobalEvents,
  type OcComposerModelOption,
} from './services/opencodeApi'
import {
  normalizeSessionDirectory,
  uniqueDirectoriesFromSessions,
  directoryKey,
  sameDirectory,
} from './utils/sessionFolders'
import { resolveVibeTraceDefaultModelRef } from './config/opencodeDefaults'
import type {
  MappedAction,
  OcMessage,
  OcPendingPermissionRequest,
  OcPendingQuestionRequest,
  OcPermissionReply,
  OcPermissionTraceEvent,
  OcSessionCompactionEvent,
  OcTodo,
} from './types/opencode'
import type { TurnTrace } from './types/trace'
import type { MessageSendPayload } from './components/MessageInput'
import Sidebar from './components/Sidebar'
import MessagePanel from './components/MessagePanel'
import SubtaskDebugPanel from './components/SubtaskDebugPanel'
import FullscreenSubtaskPanel from './components/FullscreenSubtaskPanel'
import ActionAnalysisModal from './components/ActionAnalysisModal'
import ForkSessionModal from './components/ForkSessionModal'
import SubtaskMessageConnector from './components/SubtaskMessageConnector'
import { experimentTelemetry } from './experiment/telemetry'
import { groupAssistantSubtasks, isTodoWriteMessage } from './utils/subtaskGrouping'
import {
  findSubtaskIndexForTodo,
  subtaskShouldUseTodoLink,
} from './utils/subtaskLinkage'
import { actionKeyMessageId } from './utils/actionKey'
import { firstFlowAnchorKeyForSubtaskSegment } from './utils/actionMapping'
import {
  isCompactionEventType,
  isPermissionAskEventType,
  isPermissionReplyEventType,
  parseActionRelatedSseEvent,
  parsePendingPermissionFromSse,
  sseEventTypeFromRaw,
} from './utils/opencodeSse'
import {
  archivedCompletedList,
  buildSessionTodoModel,
  getLatestTodowriteBatchProgress,
  latestActiveForMessagePanel,
} from './utils/todoRegistry'
import { SHOW_COMPOSER_MODEL_UI } from './config/featureFlags'
import { STORAGE_KEYS, MAIN_COLUMN_BOTTOM_INSET_PX } from './config/storageKeys'
import { buildUserMessageWithGuidance } from './config/harnessGuidance'
import {
  buildForkPanelSnapshotBundle,
  getForkPanelSnapshotBundle,
  saveForkPanelSnapshotBundle,
  type ForkFromActionContext,
  type ForkPanelSnapshotBundle,
} from './utils/forkPanelSnapshot'
import {
  findRecentAssistantStopMessages,
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
import { fetchPanelAnalysisForSession, fetchTaskSegmentsForSession, inheritForkTaskState, ingestTraceReference, notifyTaskSwitchPrompt, requestPanelAnalysis, type MemoryWorkerErrorDiagnosis, type MemoryWorkerIngestResult } from './services/memoryWorkerApi'
import { mergePanelAnalysisItemsIntoBucket } from './utils/panelAnalysisStorage'
import { buildFlowEndSummary } from './utils/flowEndSummary'
import { buildSubtaskCardMetrics } from './utils/subtaskMetrics'
import {
  cloneTaskSegmentTabs,
  filterTaskTabsForFork,
  mergeTaskSegmentTabs,
  reconcileTaskTabsWithMessages,
  filterSubtasksForTaskSegmentRange,
  resolveVisibleTaskSegmentRange,
  sortTaskSegmentTabsByMessages,
  taskSegmentFromWorker,
  taskSegmentTabsFromWorkerBatch,
  type TaskSegmentTab,
} from './utils/taskSegmentStorage'
import {
  collectInternalSessionIdsFromIngest,
  collectInternalSessionIdsFromPanelAnalysis,
  isMemoryWorkerInternalSession,
  registerMemoryWorkerInternalSessionIds,
  shouldHideSessionFromHistory,
  shouldSkipPanelAnalysisForSession,
  shouldSkipTraceIngestForSession,
} from './utils/memoryWorkerSessions'
import { scheduleMwInternalSessionRefresh } from './utils/mwInternalSessionRefresh'
import { traceSessionTurnLimit } from './config/traceIngest'

declare global {
  interface Window {
    __vibetraceDebug?: {
      getMessages: () => Promise<OcMessage[]>
      latestTrace: () => TurnTrace | null
      pendingPermission: () => OcPendingPermissionRequest | null
      recentCompaction: () => OcSessionCompactionEvent | null
      hydratePermissions: () => Promise<OcPendingPermissionRequest[]>
    }
  }
}

/** Map: message index containing a todo write → todos captured at that instant (for replaying diffs) */
type TodosSnapshotMap = Record<string, OcTodo[]>

function isTaskSwitchedIngestResult(result: MemoryWorkerIngestResult): boolean {
  const decision = result.taskSwitch?.decision
  if (!decision || typeof decision !== 'object') return false
  return (decision as { task_switched?: boolean }).task_switched === true
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
const SIDEBAR_SESSION_LIST_DEFAULT_WIDTH = 240
const SIDEBAR_SESSION_LIST_MIN_WIDTH = 180
const SIDEBAR_SESSION_LIST_MAX_WIDTH = 420
const MESSAGE_PANEL_MIN_WIDTH = 420
const SUBTASK_PANEL_DEFAULT_WIDTH = 630
const SUBTASK_PANEL_MIN_WIDTH = 420
const SUBTASK_PANEL_MAX_WIDTH = 1040

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

function loadSidebarSessionListWidthFromLs(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.sidebarSessionListWidth)
    const n = raw ? Number(raw) : NaN
    if (!Number.isFinite(n)) return SIDEBAR_SESSION_LIST_DEFAULT_WIDTH
    return clampNumber(n, SIDEBAR_SESSION_LIST_MIN_WIDTH, SIDEBAR_SESSION_LIST_MAX_WIDTH)
  } catch {
    return SIDEBAR_SESSION_LIST_DEFAULT_WIDTH
  }
}

function parseEnvDirectorySeeds(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(/[;\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
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

function loadKnownDirectories(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.knownDirectories)
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

function mergeKnownDirectories(...lists: Array<string | undefined>[]): string[] {
  const set = new Set<string>()
  for (const list of lists) {
    for (const raw of list) {
      const dir = normalizeSessionDirectory(raw)
      if (dir) set.add(dir)
    }
  }
  return [...set]
}

const DIRECTORY_RAIL_ROOT_KEY = '\0root'

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
        .map((d) => (typeof d === 'string' ? normalizeSessionDirectory(d.trim()) : ''))
        .filter((d) => d.length > 0),
    ),
  )
  if (dedup.length === 0) return []

  try {
    const bulk = await getSessions({ limit: OPENCODE_SESSION_DIRECTORY_LIMIT })
    const fromBulk = bulk.filter((s) => dedup.some((d) => sameDirectory(s.directory, d)))
    const covered = new Set(
      dedup.filter((d) => fromBulk.some((s) => sameDirectory(s.directory, d))),
    )
    const missing = dedup.filter((d) => !covered.has(d))
    if (missing.length === 0) return fromBulk

    const extras = await Promise.all(
      missing.map(async (dir) => {
        try {
          return await getSessionsForDirectory(dir)
        } catch {
          return [] as OcSession[]
        }
      }),
    )
    return mergeSessionsById([fromBulk, ...extras])
  } catch {
    const lists = await Promise.all(
      dedup.map(async (dir) => {
        try {
          return await getSessionsForDirectory(dir)
        } catch {
          return [] as OcSession[]
        }
      }),
    )
    return mergeSessionsById(lists)
  }
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
  const [knownDirectories, setKnownDirectories] = useState<string[]>(() =>
    mergeKnownDirectories(loadKnownDirectories(), loadManualDirectories()),
  )
  const [closedDirectories, setClosedDirectories] = useState<string[]>(() => loadClosedDirectories())
  const [creatingSession, setCreatingSession] = useState(false)
  /** Pending question requests keyed by session (from SSE `question.asked`) */
  const [pendingQuestions, setPendingQuestions] = useState<Record<string, OcPendingQuestionRequest>>({})
  const [questionSubmitting, setQuestionSubmitting] = useState(false)
  /**
   * Pending permission asks per session (queue).
   * OpenCode can fire several asks in one turn; a single slot + REST overwrite
   * caused "first dialog works, later ones never show".
   */
  const [pendingPermissionQueues, setPendingPermissionQueues] = useState<
    Record<string, OcPendingPermissionRequest[]>
  >({})
  const [permissionSubmitting, setPermissionSubmitting] = useState(false)
  /** Permission asks kept on the action-flow trail after Allow / Reject / Always */
  const [permissionTracesBySessionId, setPermissionTracesBySessionId] = useState<
    Record<string, OcPermissionTraceEvent[]>
  >({})
  /** Latest SSE compaction marker per session (merged into action flow until message parts catch up) */
  const [sessionCompactions, setSessionCompactions] = useState<Record<string, OcSessionCompactionEvent>>({})
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
  /** Panel analysis in-flight / claimed: sessionId:subtaskId */
  const panelAnalysisRequestedRef = useRef<Set<string>>(new Set())
  const panelAnalysisBySessionIdRef = useRef(panelAnalysisBySessionId)
  panelAnalysisBySessionIdRef.current = panelAnalysisBySessionId

  const pendingForkRef = useRef(pendingFork)
  pendingForkRef.current = pendingFork

  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const knownDirectoriesRef = useRef(knownDirectories)
  knownDirectoriesRef.current = knownDirectories
  const selectedDirectoryRef = useRef(selectedDirectory)
  selectedDirectoryRef.current = selectedDirectory

  /** Keep experiment event routing aligned with the workspace the user is viewing. */
  useEffect(() => {
    experimentTelemetry.setCurrentDirectory(selectedDirectory)
  }, [selectedDirectory])
  const initialSessionsLoadedRef = useRef(false)

  const refreshSessions = useCallback(
    async (extraDirectories?: Array<string | undefined>) => {
      const base = await getSessions({ limit: OPENCODE_SESSION_RECENT_LIMIT })
      const discovered = await getProjectDirectories().catch(() => [] as string[])
      const current = await getCurrentWorkspaceDirectory().catch(() => null)
      const mergedDiscovered = Array.from(new Set([...discovered, ...(current ? [current] : [])]))
      setProjectDirectories(mergedDiscovered)
      const closed = new Set(closedDirectories)
      const activeDirectory = selectedDirectoryRef.current
      const directorySeeds = mergeKnownDirectories(
        knownDirectoriesRef.current,
        envDirectorySeeds,
        manualDirectories,
        mergedDiscovered,
        uniqueDirectoriesFromSessions(base),
        extraDirectories ?? [],
        activeDirectory ? [activeDirectory] : [],
      ).filter((d) => !closed.has(d))
      const extra = await fetchSessionsAcrossDirectories(directorySeeds)
      const merged = mergeSessionsById([base, extra]).filter(
        (s) => !closed.has(normalizeSessionDirectory(s.directory)),
      )
      const nextKnown = mergeKnownDirectories(
        knownDirectoriesRef.current,
        uniqueDirectoriesFromSessions(merged),
        mergedDiscovered,
        manualDirectories,
        envDirectorySeeds,
      )
      setKnownDirectories(nextKnown)
      setSessions(merged)
      registerMemoryWorkerInternalSessionIds(
        merged.filter((s) => isMemoryWorkerInternalSession(s)).map((s) => s.id),
      )
      setApiConnected(true)
      return merged
    },
    [envDirectorySeeds, manualDirectories, closedDirectories],
  )

  const directories = useMemo(() => {
    const fromSession = uniqueDirectoriesFromSessions(sessions)
    const hasRootSessions = sessions.some((s) => !normalizeSessionDirectory(s.directory))
    const mergedRaw = [
      ...fromSession,
      ...projectDirectories.map((d) => normalizeSessionDirectory(d)),
      ...manualDirectories,
      ...knownDirectories,
      selectedDirectory,
      ...(hasRootSessions ? [''] : []),
    ]
    const map = new Map<string, string>()
    for (const dir of mergedRaw) {
      const normalized = normalizeSessionDirectory(dir)
      const key = normalized === '' ? DIRECTORY_RAIL_ROOT_KEY : directoryKey(normalized)
      if (map.has(key)) continue
      map.set(key, normalized)
    }
    const merged = [...map.values()]
      .filter((d) => d !== 'Unknown')
      .filter((d) => !closedDirectories.includes(d))
    return merged.sort((a, b) => {
      if (!a) return -1
      if (!b) return 1
      return a.localeCompare(b, 'zh-CN')
    })
  }, [sessions, projectDirectories, manualDirectories, knownDirectories, selectedDirectory, closedDirectories])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.manualDirectories, JSON.stringify(manualDirectories))
  }, [manualDirectories])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.knownDirectories, JSON.stringify(knownDirectories))
  }, [knownDirectories])

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
      .filter(s => !shouldHideSessionFromHistory(s.id, s))
      .sort((a, b) => b.time.updated - a.time.updated)
  }, [sessions, selectedDirectory])

  const linkAreaRef = useRef<HTMLDivElement>(null)
  const messageScrollRef = useRef<HTMLDivElement>(null)
  const todoPanelScrollRef = useRef<HTMLDivElement>(null)
  const subtaskScrollRef = useRef<HTMLDivElement>(null)
  const [sidebarSessionListWidth, setSidebarSessionListWidth] = useState(() => loadSidebarSessionListWidthFromLs())
  const [isResizingSidebarSessionList, setIsResizingSidebarSessionList] = useState(false)
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
      window.localStorage.setItem(
        STORAGE_KEYS.sidebarSessionListWidth,
        String(Math.round(sidebarSessionListWidth)),
      )
    } catch {
      /* ignore */
    }
  }, [sidebarSessionListWidth])

  const handleSidebarSessionListResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()

      const startX = event.clientX
      const startWidth = sidebarSessionListWidth
      let latestWidth = clampNumber(
        startWidth,
        SIDEBAR_SESSION_LIST_MIN_WIDTH,
        SIDEBAR_SESSION_LIST_MAX_WIDTH,
      )
      const previousCursor = document.body.style.cursor
      const previousUserSelect = document.body.style.userSelect

      setIsResizingSidebarSessionList(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const notifyLayoutChanged = () => {
        window.dispatchEvent(new Event('resize'))
      }
      const handlePointerMove = (moveEvent: PointerEvent) => {
        latestWidth = clampNumber(
          startWidth + (moveEvent.clientX - startX),
          SIDEBAR_SESSION_LIST_MIN_WIDTH,
          SIDEBAR_SESSION_LIST_MAX_WIDTH,
        )
        setSidebarSessionListWidth(latestWidth)
        notifyLayoutChanged()
      }
      const stopResize = () => {
        setIsResizingSidebarSessionList(false)
        document.body.style.cursor = previousCursor
        document.body.style.userSelect = previousUserSelect
        window.removeEventListener('pointermove', handlePointerMove)
        window.removeEventListener('pointerup', stopResize)
        window.removeEventListener('pointercancel', stopResize)
        try {
          window.localStorage.setItem(STORAGE_KEYS.sidebarSessionListWidth, String(Math.round(latestWidth)))
        } catch {
          /* ignore */
        }
        notifyLayoutChanged()
      }

      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', stopResize)
      window.addEventListener('pointercancel', stopResize)
    },
    [sidebarSessionListWidth],
  )

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
  const pendingPermissionQueuesRef = useRef(pendingPermissionQueues)
  pendingPermissionQueuesRef.current = pendingPermissionQueues
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const autoAbortedRunningKeysRef = useRef<Set<string>>(new Set())
  /** Bumped on abort so in-flight post-send polls stop treating the turn as active. */
  const abortGenerationRef = useRef(0)

  const upsertPermissionTrace = useCallback((req: OcPendingPermissionRequest) => {
    const askedAt = req.askedAt ?? Date.now()
    setPermissionTracesBySessionId((prev) => {
      const list = prev[req.sessionID] ?? []
      const idx = list.findIndex((t) => t.id === req.id)
      if (idx >= 0) {
        const cur = list[idx]!
        if (cur.status !== 'pending') return prev
        const next = [...list]
        next[idx] = {
          ...cur,
          permission: req.permission,
          patterns: req.patterns,
          tool: req.tool ?? cur.tool,
          askedAt: cur.askedAt || askedAt,
        }
        return { ...prev, [req.sessionID]: next }
      }
      const row: OcPermissionTraceEvent = {
        id: req.id,
        sessionID: req.sessionID,
        permission: req.permission,
        patterns: req.patterns,
        askedAt,
        status: 'pending',
        tool: req.tool,
      }
      return { ...prev, [req.sessionID]: [...list, row] }
    })
  }, [])

  /** True when the tool tied to this ask is still blocked (or not in transcript yet). */
  const isPermissionAskLive = useCallback((req: OcPendingPermissionRequest, msgs: OcMessage[]) => {
    const callID = req.tool?.callID
    if (!callID) return true
    for (const m of msgs) {
      for (const p of m.parts) {
        if (p.type !== 'tool') continue
        if (p.callID !== callID) continue
        const s = p.state?.status
        return s === 'running' || s === 'pending'
      }
    }
    // Ask can arrive before the tool part is refreshed — keep it.
    return true
  }, [])

  /** Append asks into the per-session queue (dedupe by id, preserve existing order). */
  const enqueuePermissions = useCallback((items: OcPendingPermissionRequest[]) => {
    if (items.length === 0) return
    setPendingPermissionQueues((prev) => {
      let changed = false
      const next = { ...prev }
      for (const item of items) {
        const sid = item.sessionID
        const queue = next[sid] ?? []
        const idx = queue.findIndex((p) => p.id === item.id)
        if (idx >= 0) {
          const cur = queue[idx]!
          const merged: OcPendingPermissionRequest = {
            ...cur,
            ...item,
            directory: item.directory ?? cur.directory,
            askedAt: cur.askedAt ?? item.askedAt ?? Date.now(),
          }
          if (
            merged.permission === cur.permission &&
            merged.directory === cur.directory &&
            merged.patterns.length === cur.patterns.length
          ) {
            continue
          }
          const copy = [...queue]
          copy[idx] = merged
          next[sid] = copy
          changed = true
        } else {
          next[sid] = [
            ...queue,
            { ...item, askedAt: item.askedAt ?? Date.now() },
          ]
          changed = true
          console.info('[VibeTrace][permission] enqueued', {
            sessionID: sid,
            id: item.id,
            permission: item.permission,
            queueLength: (next[sid] ?? []).length,
          })
        }
      }
      return changed ? next : prev
    })
  }, [])

  /** Remove one ask; leave any remaining asks so the next dialog can show. */
  const dequeuePermission = useCallback((sessionID: string, requestID: string) => {
    setPendingPermissionQueues((prev) => {
      const queue = prev[sessionID]
      if (!queue?.length) return prev
      const filtered = queue.filter((p) => p.id !== requestID)
      if (filtered.length === queue.length) return prev
      if (filtered.length === 0) {
        const { [sessionID]: _, ...rest } = prev
        return rest
      }
      return { ...prev, [sessionID]: filtered }
    })
  }, [])

  const headPendingPermission = useCallback(
    (sessionID: string | null | undefined): OcPendingPermissionRequest | null => {
      if (!sessionID) return null
      return pendingPermissionQueues[sessionID]?.[0] ?? null
    },
    [pendingPermissionQueues],
  )

  const resolvePermissionTrace = useCallback(
    (sessionID: string, requestID: string, reply?: OcPermissionReply) => {
      setPermissionTracesBySessionId((prev) => {
        const list = prev[sessionID]
        if (!list?.length) return prev
        const idx = list.findIndex((t) => t.id === requestID)
        if (idx < 0) return prev
        const cur = list[idx]!
        if (cur.status !== 'pending' && cur.reply) return prev
        const next = [...list]
        next[idx] = {
          ...cur,
          reply,
          repliedAt: Date.now(),
          status: reply === 'reject' ? 'error' : 'completed',
        }
        return { ...prev, [sessionID]: next }
      })
    },
    [],
  )

  const activeSessionDirectory = useMemo(
    () => sessions.find(s => s.id === selectedSessionId)?.directory,
    [sessions, selectedSessionId],
  )

  const envBootstrapModel = useMemo(() => resolveVibeTraceDefaultModelRef(), [])

  const composerModelOptionsForUi = useMemo(() => {
    const t = composerModelRef.trim()
    if (!t || composerModelOptions.some((o) => o.ref === t)) return composerModelOptions
    return [...composerModelOptions, { ref: t, label: `${t} (saved locally)`, providerId: t.split('/')[0] || 'saved', providerName: 'Saved' }].sort((a, b) =>
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
        if (cancelled) return
        setComposerModelOptions(options)
        // First visit / cleared selection: pick VibeTrace default (not OpenCode user config).
        setComposerModelRef((prev) => {
          if (prev.trim()) return prev
          const next = resolveVibeTraceDefaultModelRef()
          try {
            window.localStorage.setItem(STORAGE_KEYS.composerModelRef, next)
          } catch {
            /* ignore */
          }
          return next
        })
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
    () => (selectedSessionId ? getForkPanelSnapshotBundle(selectedSessionId) : null),
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
    experimentTelemetry.onTaskTabSelect(taskSegmentId, sessionId)
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
      if (diagnosisItems.some((item) => item.status === 'running')) {
        for (const delayMs of [2500, 8000]) {
          window.setTimeout(() => {
            void fetchPanelAnalysisForSession(sessionId)
              .then((batch) => {
                if (batch.items?.length) mergePanelAnalysisItems(sessionId, batch.items)
              })
              .catch((err) => console.warn('[VibeTrace][panel-analysis refresh failed]', err))
          }, delayMs)
        }
      }
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
      const taskSwitched = isTaskSwitchedIngestResult(result)
      const merged = mergeTaskSegmentTabs(existing, nextTabs, { taskSwitched })
      return { ...prev, [sessionId]: merged }
    })

    const preferred = nextTabs.find((tab) => tab.status === 'pending') ?? nextTabs[nextTabs.length - 1]
    const taskSwitched = isTaskSwitchedIngestResult(result)
    if (preferred) {
      if (taskSwitched) {
        // New task tab just appeared — follow it even if the user had pinned an older tab.
        setTaskSegmentManuallySelectedBySessionId((prev) => {
          if (!prev[sessionId]) return prev
          const next = { ...prev }
          delete next[sessionId]
          return next
        })
        setActiveTaskSegmentBySessionId((prev) => ({ ...prev, [sessionId]: preferred.id }))
      } else {
        setActiveTaskSegmentBySessionId((prev) => {
          if (taskSegmentManuallySelectedBySessionId[sessionId] && prev[sessionId]) return prev
          return { ...prev, [sessionId]: preferred.id }
        })
      }
    }
    console.info('[VibeTrace][task-segments applied]', {
      sessionId,
      added: nextTabs,
      active: preferred?.id,
    })
    if (isTaskSwitchedIngestResult(result) || result.extractedTask) {
      scheduleMwInternalSessionRefresh(refreshSessions)
    }
  }, [taskSegmentManuallySelectedBySessionId, mergePanelAnalysisItems, refreshSessions])

  const refreshTaskSegmentsFromWorker = useCallback(async (sessionId: string, messagesForReconcile?: OcMessage[]) => {
    const batch = await fetchTaskSegmentsForSession(sessionId)
    const workerTabs = taskSegmentTabsFromWorkerBatch(batch.tabs ?? [])
    if (workerTabs.length === 0) return
    setTaskSegmentsBySessionId((prev) => {
      const existing = prev[sessionId] ?? []
      const merged = mergeTaskSegmentTabs(existing, workerTabs)
      const reconciled = messagesForReconcile?.length
        ? reconcileTaskTabsWithMessages(merged, messagesForReconcile)
        : merged
      return { ...prev, [sessionId]: reconciled }
    })
    const preferred = workerTabs.find((tab) => tab.status === 'pending') ?? workerTabs[workerTabs.length - 1]
    if (preferred) {
      setActiveTaskSegmentBySessionId((prev) => {
        if (taskSegmentManuallySelectedBySessionId[sessionId] && prev[sessionId]) return prev
        return { ...prev, [sessionId]: preferred.id }
      })
    }
  }, [taskSegmentManuallySelectedBySessionId])

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

  // Load sessions once on mount — do not re-run when refreshSessions identity changes (would reset workspace selection).
  useEffect(() => {
    if (initialSessionsLoadedRef.current) return
    initialSessionsLoadedRef.current = true
    refreshSessions()
      .then((data) => {
        const sorted = [...data]
          .filter((s) => !shouldHideSessionFromHistory(s.id, s))
          .sort((a, b) => b.time.updated - a.time.updated)
        if (sorted.length > 0) {
          const first = sorted[0]!
          setSelectedSessionId(first.id)
          setSelectedDirectory(normalizeSessionDirectory(first.directory))
        }
      })
      .catch(() => setApiConnected(false))
  }, [refreshSessions])

  /** If the active session disappears or is hidden, fall back to newest visible session in folder. */
  useEffect(() => {
    const visibleInFolder = sessions
      .filter(s => sameDirectory(s.directory, selectedDirectory))
      .filter(s => !shouldHideSessionFromHistory(s.id, s))
      .sort((a, b) => b.time.updated - a.time.updated)

    if (visibleInFolder.length === 0) return
    if (selectedSessionId && visibleInFolder.some(s => s.id === selectedSessionId)) return

    setSelectedSessionId(visibleInFolder[0]!.id)
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
    const stopMessages = findRecentAssistantStopMessages(messages)
    if (stopMessages.length === 0) return

    const timers: Array<{ timer: number; sid: string; endAssistantMessageId: string; traceKey: string }> = []
    for (const stopMessage of stopMessages) {
      const stopId = stopMessage.info.id
      if (!isAssistantStopWithinIngestWindow(stopMessage)) {
        const completedMs = getAssistantStopCompletedMs(stopMessage)
        console.info('[VibeTrace][trace] skip ingest — stop older than fresh window', {
          sessionID: selectedSessionId,
          stopId,
          completedMs,
          ageSec: completedMs != null ? Math.round((Date.now() - completedMs) / 1000) : null,
          windowSec: TRACE_INGEST_FRESH_WINDOW_MS / 1000,
        })
        continue
      }

      const traceKey = `${selectedSessionId}:${stopId}`
      if (processedTraceTurnKeysRef.current.has(traceKey)) continue
      if (traceIngestDebounceStartedRef.current.has(traceKey)) continue
      if (hasTraceIngestClaim(selectedSessionId, stopId)) {
        console.info('[VibeTrace][trace] skip ingest — already processed (claim lock)', { traceKey })
        continue
      }
      if (!tryClaimTraceIngest(selectedSessionId, stopId)) {
        console.info('[VibeTrace][trace] skip ingest — claim race lost', { traceKey })
        continue
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
            const diagnosisBatch = ingestResult.errorDiagnosis
            if (ingestResult.duplicate) {
              processedTraceTurnKeysRef.current.add(traceKey)
              console.info('[VibeTrace][memory-worker ingest duplicate skipped]', ingestResult)
            } else if (ingestResult.ok === false && !diagnosisBatch) {
              releaseTraceIngestClaim(sid, endAssistantMessageId)
              traceIngestDebounceStartedRef.current.delete(traceKey)
              console.warn('[VibeTrace][memory-worker ingest incomplete]', ingestResult.error ?? ingestResult)
            } else {
              processedTraceTurnKeysRef.current.add(traceKey)
              registerMemoryWorkerInternalSessionIds(collectInternalSessionIdsFromIngest(ingestResult))
              scheduleMwInternalSessionRefresh(refreshSessions)
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
      timers.push({ timer, sid, endAssistantMessageId, traceKey })
    }

    return () => {
      for (const { timer, sid, endAssistantMessageId, traceKey } of timers) {
        window.clearTimeout(timer)
        // SSE may refresh messages inside debounce; marking "processed" too early cancels the timer and skips ingest forever
        if (!traceIngestDebounceStartedRef.current.has(traceKey)) {
          releaseTraceIngestClaim(sid, endAssistantMessageId)
        }
      }
    }
  }, [messages, selectedSessionId, sessions, loading, applyMemoryWorkerTaskSegments, refreshSessions])

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
      pendingPermission: () =>
        selectedSessionIdRef.current
          ? pendingPermissionQueuesRef.current[selectedSessionIdRef.current]?.[0] ?? null
          : null,
      recentCompaction: () =>
        selectedSessionIdRef.current
          ? sessionCompactions[selectedSessionIdRef.current] ?? null
          : null,
      hydratePermissions: async () => {
        const sid = selectedSessionIdRef.current
        if (!sid) return []
        const dir = sessionsRef.current.find((s) => s.id === sid)?.directory
        const list = await getPendingPermissions(dir, { sessionID: sid })
        console.info('[VibeTrace][permission] manual hydrate', list)
        return list
      },
    }
    return () => {
      delete window.__vibetraceDebug
    }
  }, [latestTurnTrace, sessionCompactions])

  // Subscribe to global SSE events
  useEffect(() => {
    const unsubscribe = subscribeGlobalEvents((event) => {
      const payload = event?.payload || event
      const eventType = sseEventTypeFromRaw(event) ?? payload?.type
      if (!eventType) return
      const isNoisyDelta =
        eventType === 'message.part.delta' || eventType === 'session.next.compaction.delta'
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

      if (isPermissionAskEventType(eventType)) {
        const fromHelper = parsePendingPermissionFromSse(event)
        const props = (payload.properties ?? payload.data ?? payload) as Record<string, unknown>
        const root = event as { directory?: string }
        const dir = typeof root.directory === 'string' ? root.directory : undefined
        const sessionHint =
          (typeof props.sessionID === 'string' && props.sessionID) ||
          (typeof props.sessionId === 'string' && props.sessionId) ||
          (typeof (payload as { sessionID?: string }).sessionID === 'string' &&
            (payload as { sessionID: string }).sessionID) ||
          undefined
        const normalized =
          fromHelper ??
          normalizePermissionRequest(props, {
            directory: dir,
            askedAt: Date.now(),
            sessionID: sessionHint,
          }) ??
          normalizePermissionRequest(payload, {
            directory: dir,
            askedAt: Date.now(),
            sessionID: sessionHint,
          })
        if (normalized) {
          console.info('[VibeTrace][permission] captured', {
            eventType,
            id: normalized.id,
            permission: normalized.permission,
            sessionID: normalized.sessionID,
            patterns: normalized.patterns.slice(0, 3),
          })
          upsertPermissionTrace({
            ...normalized,
            directory: normalized.directory ?? dir,
            askedAt: normalized.askedAt ?? Date.now(),
          })
          enqueuePermissions([
            {
              ...normalized,
              directory: normalized.directory ?? dir,
              askedAt: normalized.askedAt ?? Date.now(),
            },
          ])
        } else {
          console.warn('[VibeTrace][permission] SSE ask parse failed', eventType, event)
        }
      }

      if (isPermissionReplyEventType(eventType)) {
        const props = (payload.properties ?? payload.data ?? payload) as {
          sessionID?: string
          sessionId?: string
          requestID?: string
          id?: string
          reply?: string
        }
        const sid = props?.sessionID ?? props?.sessionId
        const requestID = props?.requestID ?? props?.id
        const replyRaw = props?.reply
        const reply =
          replyRaw === 'once' || replyRaw === 'always' || replyRaw === 'reject'
            ? replyRaw
            : undefined
        if (sid && requestID) {
          resolvePermissionTrace(sid, requestID, reply)
          dequeuePermission(sid, requestID)
        } else if (sid) {
          // Reply without request id — only clear if queue is a single unknown ask
          setPendingPermissionQueues((prev) => {
            if (!(sid in prev)) return prev
            const { [sid]: _, ...rest } = prev
            return rest
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

      if (eventType.startsWith('permission')) {
        const props = (payload.properties ?? payload.data ?? payload) as {
          sessionID?: string
          sessionId?: string
        }
        const sid = props?.sessionID ?? props?.sessionId
        if (sid && sid === selectedSessionIdRef.current) {
          const dir = sessionsRef.current.find((s) => s.id === sid)?.directory
          getMessages(sid, `SSE:${eventType}`, dir).then(setMessages).catch(() => {})
          // REST merge — never replace the whole queue with a single "latest" row
          // (stale aborted asks in /permission used to overwrite the live SSE ask).
          getPendingPermissions(dir, { sessionID: sid })
            .then((list) => {
              if (selectedSessionIdRef.current !== sid || list.length === 0) return
              const msgs = messagesRef.current
              const live = list.filter((item) => isPermissionAskLive(item, msgs))
              const toAdd = (live.length > 0 ? live : list).map((item) => ({
                ...item,
                directory: item.directory ?? dir,
                askedAt: item.askedAt ?? Date.now(),
              }))
              for (const item of toAdd) {
                upsertPermissionTrace(item)
              }
              enqueuePermissions(toAdd)
              console.info('[VibeTrace][permission] merged after SSE', {
                sessionID: sid,
                count: toAdd.length,
                ids: toAdd.map((p) => p.id),
              })
            })
            .catch(() => {})
        }
      }

      if (isCompactionEventType(eventType)) {
        const parsed = parseActionRelatedSseEvent(event)
        const props = payload.properties as { sessionID?: string; sessionId?: string; text?: string; reason?: string } | undefined
        const sid =
          parsed?.sessionID ??
          props?.sessionID ??
          props?.sessionId ??
          selectedSessionIdRef.current
        if (sid) {
          const status =
            parsed?.compaction?.status ??
            (eventType === 'session.next.compaction.started' ||
            eventType === 'session.next.compaction.delta'
              ? 'running'
              : 'completed')
          const detail =
            parsed?.compaction?.detail ??
            (typeof props?.text === 'string' && props.text.trim()
              ? props.text.trim().slice(0, 120)
              : eventType)
          const marker: OcSessionCompactionEvent = {
            sessionID: sid,
            time: parsed?.time ?? Date.now(),
            status,
            detail,
          }
          setSessionCompactions((prev) => ({ ...prev, [sid]: marker }))
          console.info('[VibeTrace][compaction] captured', marker)
          if (status === 'completed' && (!sid || sid === selectedSessionIdRef.current)) {
            setCompactionControlHint(
              `Context compacted · ${new Date().toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}`,
            )
          }
          if (sid === selectedSessionIdRef.current) {
            const dir = sessionsRef.current.find((s) => s.id === sid)?.directory
            getMessages(sid, `SSE:${eventType}`, dir).then(setMessages).catch(() => {})
          }
        }
      }

      if (eventType === 'message.part.delta') {
        // Very high-frequency token stream event; avoid fan-out REST refresh storms.
        return
      }

      // message.part.updated may carry a compaction part before session.compacted fires
      if (eventType === 'message.part.updated') {
        const part = (payload.properties as { part?: { type?: string; sessionID?: string } } | undefined)?.part
        if (part?.type === 'compaction' && part.sessionID) {
          const sid = part.sessionID
          const marker: OcSessionCompactionEvent = {
            sessionID: sid,
            time: Date.now(),
            status: 'completed',
            detail: 'compaction part',
          }
          setSessionCompactions((prev) => ({ ...prev, [sid]: marker }))
          console.info('[VibeTrace][compaction] captured from message.part.updated', marker)
        }
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
    })

    return unsubscribe
  }, [selectedSessionId, refreshSessions, upsertPermissionTrace, resolvePermissionTrace, enqueuePermissions, dequeuePermission, isPermissionAskLive])

  /**
   * REST poll fallback while the agent is still running.
   * Does NOT stop just because one permission dialog is open — a turn can ask multiple times.
   * Idle sessions do not poll; SSE + session-load hydrate remain primary.
   */
  const permissionPollArmed = useMemo(() => {
    if (!selectedSessionId) return false
    if (waitingForAssistantReply) return true
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (!m || m.info.role !== 'assistant') continue
      return m.parts.some(
        (p) => p.type === 'tool' && (p.state?.status === 'running' || p.state?.status === 'pending'),
      )
    }
    return false
  }, [selectedSessionId, waitingForAssistantReply, messages])

  useEffect(() => {
    if (!selectedSessionId || !permissionPollArmed) return
    let cancelled = false
    const poll = async () => {
      const sid = selectedSessionIdRef.current
      if (!sid || cancelled) return
      const dir = sessionsRef.current.find((s) => s.id === sid)?.directory
      try {
        const list = await getPendingPermissions(dir, { sessionID: sid })
        if (cancelled || selectedSessionIdRef.current !== sid) return
        if (list.length === 0) return
        const live = list.filter((item) => isPermissionAskLive(item, messagesRef.current))
        const toAdd = (live.length > 0 ? live : list).map((item) => ({
          ...item,
          directory: item.directory ?? dir,
          askedAt: item.askedAt ?? Date.now(),
        }))
        for (const item of toAdd) upsertPermissionTrace(item)
        enqueuePermissions(toAdd)
      } catch {
        /* endpoint may be unavailable on older OpenCode builds */
      }
    }
    void poll()
    const id = window.setInterval(() => void poll(), 3000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [selectedSessionId, permissionPollArmed, upsertPermissionTrace, enqueuePermissions, isPermissionAskLive])

  /** Drop asks whose tool already finished (aborted/completed) so the queue advances. */
  useEffect(() => {
    if (!selectedSessionId) return
    setPendingPermissionQueues((prev) => {
      const cur = prev[selectedSessionId]
      if (!cur?.length) return prev
      const next = cur.filter((p) => isPermissionAskLive(p, messages))
      if (next.length === cur.length) return prev
      if (next.length === 0) {
        const { [selectedSessionId]: _, ...rest } = prev
        return rest
      }
      return { ...prev, [selectedSessionId]: next }
    })
  }, [selectedSessionId, messages, isPermissionAskLive])

  // Load messages + todos + panel analysis + task tabs when session changes
  const loadSessionData = useCallback(async (sessionId: string, directory?: string) => {
    if (!sessionId) return
    setLoading(true)
    try {
      const [msgs, td, panelBatch, taskSegmentBatch, pendingPerms] = await Promise.all([
        getMessages(sessionId, 'initial load / session switch', directory),
        getTodos(sessionId, directory),
        fetchPanelAnalysisForSession(sessionId).catch((err) => {
          console.warn('[VibeTrace][panel-analysis] worker hydrate failed', { sessionId, err })
          return { ok: false, count: 0, items: [] as MemoryWorkerErrorDiagnosis[] }
        }),
        fetchTaskSegmentsForSession(sessionId).catch((err) => {
          console.warn('[VibeTrace][task-segments] worker hydrate failed', { sessionId, err })
          return { ok: false, sessionId, count: 0, tabs: [] }
        }),
        getPendingPermissions(directory, { sessionID: sessionId }).catch((err) => {
          console.warn('[VibeTrace][permission] hydrate failed', { sessionId, err })
          return [] as Awaited<ReturnType<typeof getPendingPermissions>>
        }),
      ])
      if (selectedSessionIdRef.current !== sessionId) return
      setMessages(msgs)
      setTodos(td)
      if (pendingPerms.length > 0) {
        const live = pendingPerms.filter((item) => isPermissionAskLive(item, msgs))
        const toAdd = (live.length > 0 ? live : pendingPerms).map((item) => ({
          ...item,
          directory: item.directory ?? directory,
          askedAt: item.askedAt ?? Date.now(),
        }))
        for (const item of toAdd) upsertPermissionTrace(item)
        enqueuePermissions(toAdd)
        console.info('[VibeTrace][permission] hydrated pending', {
          sessionId,
          count: toAdd.length,
          ids: toAdd.map((p) => p.id),
        })
      } else {
        // Do NOT clear SSE-captured asks just because REST returned [].
        // OpenCode's session permission list is often empty while a tool is still
        // blocked on an ask (VibeTrace would otherwise flash the dialog then lose it).
        const toolStillBlocked = msgs.some(
          (m) =>
            m.info.role === 'assistant' &&
            m.parts.some(
              (p) =>
                p.type === 'tool' &&
                (p.state?.status === 'running' || p.state?.status === 'pending'),
            ),
        )
        if (!toolStillBlocked) {
          setPendingPermissionQueues((prev) => {
            if (!(sessionId in prev)) return prev
            const { [sessionId]: _, ...rest } = prev
            return rest
          })
        }
      }
      if (panelBatch.items?.length) {
        mergePanelAnalysisItems(sessionId, panelBatch.items)
        console.info('[VibeTrace][panel-analysis] hydrated from worker', {
          sessionId,
          count: panelBatch.items.length,
        })
      }
      const workerTabs = taskSegmentTabsFromWorkerBatch(taskSegmentBatch.tabs ?? [])
      if (workerTabs.length > 0) {
        setTaskSegmentsBySessionId((prev) => {
          const existing = prev[sessionId] ?? []
          const merged = mergeTaskSegmentTabs(existing, workerTabs)
          const reconciled = reconcileTaskTabsWithMessages(merged, msgs)
          return { ...prev, [sessionId]: reconciled }
        })
        console.info('[VibeTrace][task-segments] hydrated from worker', {
          sessionId,
          count: workerTabs.length,
        })
      }
    } catch {
      /* loading errors surface via empty state; avoid noisy console */
    } finally {
      setLoading(false)
    }
  }, [mergePanelAnalysisItems, upsertPermissionTrace, enqueuePermissions, isPermissionAskLive])

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

  const latestActiveForPanel = useMemo(
    () => latestActiveForMessagePanel(sessionTodoModel, selectedSessionId),
    [sessionTodoModel, selectedSessionId],
  )

  const archivedForPanel = useMemo(
    () => archivedCompletedList(sessionTodoModel.completedArchive, selectedSessionId),
    [sessionTodoModel.completedArchive, selectedSessionId],
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
    return sortTaskSegmentTabsByMessages(tabs, messages)
  }, [messages, selectedSessionId, taskSegmentsBySessionId])

  useEffect(() => {
    if (!experimentTelemetry.isActive()) return
    const ids = assistantSubtasks.map((st) => st.subtask_id).filter(Boolean)
    experimentTelemetry.onSubtasksObserved(ids, selectedSessionId || undefined)
  }, [assistantSubtasks, selectedSessionId])

  useEffect(() => {
    if (!experimentTelemetry.isActive()) return
    for (const tab of taskSegmentsForActiveSession) {
      experimentTelemetry.onTaskTabSeen(tab.id, selectedSessionId || undefined)
    }
  }, [taskSegmentsForActiveSession, selectedSessionId])

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
    const range = resolveVisibleTaskSegmentRange(
      activeTaskSegment,
      taskSegmentsForActiveSession,
      messages,
    )
    // Never blank the rail when the active tab window is unresolved (new pending tab
    // after task-switch / fork, or stale message ids). Prefer a resolved prior window;
    // otherwise show the full live trajectory.
    if (!range) return visibleSubtasks

    const filtered = filterSubtasksForTaskSegmentRange(visibleSubtasks, range)
    if (filtered.length > 0 || visibleSubtasks.length === 0) return filtered

    const activeSegmentIndex = taskSegmentsForActiveSession.findIndex(
      (tab) => tab.id === activeTaskSegment.id,
    )
    const isLatestTab =
      activeSegmentIndex >= 0 && activeSegmentIndex === taskSegmentsForActiveSession.length - 1
    if (!isLatestTab) return filtered

    // Latest tab resolved but still empty (boundary ahead of live messages) — keep
    // showing whatever the previous tab owned instead of "No subtasks".
    if (activeSegmentIndex > 0) {
      const priorTabs = taskSegmentsForActiveSession.slice(0, activeSegmentIndex)
      const prior = priorTabs[priorTabs.length - 1]!
      const priorRange = resolveVisibleTaskSegmentRange(prior, priorTabs, messages)
      if (priorRange) {
        const priorFiltered = filterSubtasksForTaskSegmentRange(visibleSubtasks, priorRange)
        if (priorFiltered.length > 0) return priorFiltered
      }
    }
    return visibleSubtasks
  }, [activeTaskSegment, messages, taskSegmentsForActiveSession, visibleSubtasks])

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
      if (next !== null) {
        const st = assistantSubtasks[next]
        if (st?.subtask_id) {
          experimentTelemetry.onTrajectoryClick(selectedSessionId || undefined, {
            subtaskId: st.subtask_id,
            source: 'card',
          })
        } else {
          experimentTelemetry.onTrajectoryClick(selectedSessionId || undefined, { sourceIndex: next })
        }
      }
      setSelection((sel) => {
        if (!sel) return null
        if (next === null || sel.subtaskIndex !== next) return null
        return sel
      })
      return next
    })
  }, [assistantSubtasks, selectedSessionId])

  const handleTodoPanelClick = useCallback(
    (detail: {
      target: 'header' | 'section' | 'todo'
      section?: 'open' | 'done' | 'history'
      todoId?: string
    }) => {
      experimentTelemetry.onTodoPanelClick(selectedSessionId || undefined, detail)
    },
    [selectedSessionId],
  )

  const handlePanelBecameVisible = useCallback(
    (subtaskId: string) => {
      experimentTelemetry.onPanelView(subtaskId, selectedSessionId || undefined, 'scroll')
    },
    [selectedSessionId],
  )

  const handlePanelSealed = useCallback(
    (subtaskId: string) => {
      const sid = selectedSessionIdRef.current
      if (!sid || !subtaskId) return
      const session = sessionsRef.current.find((s) => s.id === sid)
      if (shouldSkipPanelAnalysisForSession(sid, session)) {
        console.info('[VibeTrace][panel-analysis] skip — mw-internal session', {
          sessionId: sid,
          subtaskId,
          title: session?.title,
        })
        return
      }
      const claimKey = `${sid}:${subtaskId}`
      // Durable front-end mark: one attempt per panel for this page lifetime.
      if (panelAnalysisRequestedRef.current.has(claimKey)) {
        console.info('[VibeTrace][panel-analysis] skip — already claimed', { sessionId: sid, subtaskId })
        return
      }
      const existing = panelAnalysisBySessionIdRef.current[sid]?.[subtaskId]
      // Already summarized (or in flight / previously failed) — do not re-run.
      if (existing?.status === 'ok' || existing?.status === 'running' || existing?.status === 'failed') {
        panelAnalysisRequestedRef.current.add(claimKey)
        console.info('[VibeTrace][panel-analysis] skip — already marked', {
          sessionId: sid,
          subtaskId,
          status: existing.status,
        })
        return
      }
      panelAnalysisRequestedRef.current.add(claimKey)

      const directory = session?.directory
      mergePanelAnalysisItems(sid, [
        {
          status: 'running',
          sessionId: sid,
          subtaskId,
        },
      ])
      console.info('[VibeTrace][panel-analysis] request on panel seal', { sessionId: sid, subtaskId })

      void requestPanelAnalysis({
        sessionId: sid,
        subtaskId,
        directory,
        parentSessionID: sid,
      })
        .then((batch) => {
          if (selectedSessionIdRef.current !== sid) return
          const items = batch.items ?? []
          registerMemoryWorkerInternalSessionIds(collectInternalSessionIdsFromPanelAnalysis(items))
          if (items.some((item) => item.diagnosisSessionID)) {
            scheduleMwInternalSessionRefresh(refreshSessions)
          }
          if (items.length > 0) {
            mergePanelAnalysisItems(sid, items)
            console.info('[VibeTrace][panel-analysis] received', {
              sessionId: sid,
              subtaskId,
              count: items.length,
              cached: batch.cached === true || items.some((item) => item.cached),
              status: items.map((item) => item.status),
            })
          } else if (!batch.ok) {
            mergePanelAnalysisItems(sid, [
              {
                status: 'failed',
                sessionId: sid,
                subtaskId,
                error: batch.error || batch.reason || 'panel analysis returned no items',
              },
            ])
          }
          const stillRunning = items.some((item) => item.status === 'running')
          if (stillRunning) {
            for (const delayMs of [2500, 8000]) {
              window.setTimeout(() => {
                void fetchPanelAnalysisForSession(sid)
                  .then((refresh) => {
                    if (refresh.items?.length) {
                      registerMemoryWorkerInternalSessionIds(
                        collectInternalSessionIdsFromPanelAnalysis(refresh.items),
                      )
                      mergePanelAnalysisItems(sid, refresh.items)
                    }
                  })
                  .catch((err) => console.warn('[VibeTrace][panel-analysis refresh failed]', err))
              }, delayMs)
            }
          }
        })
        .catch((err) => {
          // Keep claimKey — do not auto-loop retries for the same panel.
          console.warn('[VibeTrace][panel-analysis] failed', { sessionId: sid, subtaskId, err })
          mergePanelAnalysisItems(sid, [
            {
              status: 'failed',
              sessionId: sid,
              subtaskId,
              error: err instanceof Error ? err.message : String(err),
            },
          ])
        })
    },
    [mergePanelAnalysisItems, refreshSessions],
  )

  useEffect(() => {
    if (!experimentTelemetry.isActive()) return
    if (linkedSubtaskIndex === null) return
    const st = assistantSubtasks[linkedSubtaskIndex]
    if (st?.subtask_id) {
      experimentTelemetry.onPanelView(st.subtask_id, selectedSessionId || undefined, 'select')
    }
  }, [linkedSubtaskIndex, assistantSubtasks, selectedSessionId])

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
    [assistantSubtasks, visibleSubtasksForTaskSegment, selectedSessionId]
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

  const handlePermissionReply = useCallback(async (reply: OcPermissionReply, message?: string) => {
    const queue = pendingPermissionQueuesRef.current[selectedSessionId] ?? []
    const pp = queue[0]
    if (!pp) return
    setPermissionSubmitting(true)
    try {
      await replyToPermission(pp.id, reply, {
        sessionID: pp.sessionID,
        directory: pp.directory,
        message,
      })
      resolvePermissionTrace(pp.sessionID, pp.id, reply)
      dequeuePermission(pp.sessionID, pp.id)
      const dir = sessionsRef.current.find((s) => s.id === selectedSessionId)?.directory
      // Pull any asks that arrived while this dialog was open (REST may lag SSE).
      try {
        const list = await getPendingPermissions(dir, { sessionID: pp.sessionID })
        const live = list.filter((item) => isPermissionAskLive(item, messagesRef.current))
        if (live.length > 0) {
          const toAdd = live.map((item) => ({
            ...item,
            directory: item.directory ?? dir,
            askedAt: item.askedAt ?? Date.now(),
          }))
          for (const item of toAdd) upsertPermissionTrace(item)
          enqueuePermissions(toAdd)
        }
      } catch {
        /* ignore */
      }
      const msgs = await getMessages(selectedSessionId, 'after permission reply', dir)
      setMessages(msgs)
    } catch (err) {
      window.alert(
        `Failed to reply to permission.\n${err instanceof Error ? err.message : String(err)}\n\nEnsure OpenCode exposes POST /permission/{requestID}/reply.`,
      )
    } finally {
      setPermissionSubmitting(false)
    }
  }, [selectedSessionId, resolvePermissionTrace, dequeuePermission, enqueuePermissions, upsertPermissionTrace, isPermissionAskLive])

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
        experimentTelemetry.onConversationTurn(sid)
        experimentTelemetry.onAgentTurnStart(sid)
        void notifyTaskSwitchPrompt({
          sessionId: sid,
          userPrompt: rawUserPrompt,
          directory: dir,
          parentSessionID: sid,
          forkMeta: resolveForkIngestMeta(sid, sessionsRef.current) ?? undefined,
        })
          .then((result) => {
            applyMemoryWorkerTaskSegments(sid, result)
            window.setTimeout(() => {
              void refreshTaskSegmentsFromWorker(sid).catch((err) =>
                console.warn('[VibeTrace][task-segments prompt refresh failed]', err),
              )
            }, 1800)
          })
          .catch((err) => console.warn('[VibeTrace][task-switch prompt failed]', err))
        scheduleMwInternalSessionRefresh(refreshSessions)
        const gen = abortGenerationRef.current
        // Show stop immediately — POST /message often blocks for the whole agent turn.
        setWaitingForAssistantReply(true)
        try {
          await sendMessage(sid, text, dir, {
            imageParts: images,
            model: composerModelRef.trim() || resolveVibeTraceDefaultModelRef(),
          })
          if (abortGenerationRef.current !== gen || selectedSessionIdRef.current !== sid) {
            // Abort handler already closed the turn; otherwise close as superseded.
            experimentTelemetry.onAgentTurnEnd(sid, { superseded: true })
            return
          }
          const msgs = await getMessages(sid, 'after POST /message completes', dir)
          if (abortGenerationRef.current !== gen || selectedSessionIdRef.current !== sid) {
            experimentTelemetry.onAgentTurnEnd(sid, { superseded: true })
            return
          }
          setMessages(msgs)
          const last = msgs[msgs.length - 1]
          if (last?.info.role === 'user') {
            await pollUntilAssistantMessage(
              sid,
              dir,
              () => selectedSessionIdRef.current === sid && abortGenerationRef.current === gen,
              setMessages,
            )
          }
        } finally {
          if (abortGenerationRef.current === gen) {
            experimentTelemetry.onAgentTurnEnd(sid)
            setWaitingForAssistantReply(false)
          }
        }
      } catch (e) {
        window.alert(`Send failed: ${e instanceof Error ? e.message : String(e)}`)
        experimentTelemetry.onAgentTurnEnd(sid, { error: true })
        setWaitingForAssistantReply(false)
      }
    })()
  }, [selectedSessionId, sessions, composerModelRef, applyMemoryWorkerTaskSegments, refreshSessions, refreshTaskSegmentsFromWorker])

  const handleAbortMessage = useCallback(async () => {
    if (!selectedSessionId) return
    const sid = selectedSessionId
    const dir = sessions.find(s => s.id === sid)?.directory
    abortGenerationRef.current += 1
    experimentTelemetry.onAgentTurnEnd(sid, { aborted: true })
    setWaitingForAssistantReply(false)
    // Clear local permission/question prompts — abort cancels the turn that asked for them.
    setPendingPermissionQueues((prev) => {
      if (!(sid in prev)) return prev
      const { [sid]: _, ...rest } = prev
      return rest
    })
    setPermissionTracesBySessionId((prev) => {
      const list = prev[sid]
      if (!list?.some((t) => t.status === 'pending')) return prev
      return {
        ...prev,
        [sid]: list.map((t) =>
          t.status === 'pending'
            ? { ...t, status: 'error' as const, reply: 'reject' as const, repliedAt: Date.now() }
            : t,
        ),
      }
    })
    setPendingQuestions((prev) => {
      if (!(sid in prev)) return prev
      const { [sid]: _, ...rest } = prev
      return rest
    })
    setAborting(true)
    try {
      await abortSession(sid, dir)
      const [list, msgs] = await Promise.all([
        refreshSessions(),
        getMessages(sid, 'after abort refresh', dir),
      ])
      if (selectedSessionIdRef.current !== sid) return
      setSessions(list)
      setMessages(msgs)
    } finally {
      setAborting(false)
    }
  }, [selectedSessionId, sessions, refreshSessions])

  const selectedSession = sessions.find(s => s.id === selectedSessionId)

  const handleSelectDirectory = useCallback(
    async (dir: string) => {
      const normalized = normalizeSessionDirectory(dir)
      selectedDirectoryRef.current = normalized
      setSelectedDirectory(normalized)
      setSelectedSessionId('')
      setMessages([])
      setTodos([])
      setTodosSnapshotAtMessageIndex({})

      const list = await refreshSessions([normalized])
      const refreshedInFolder = list
        .filter(s => sameDirectory(s.directory, normalized))
        .sort((a, b) => b.time.updated - a.time.updated)
      if (refreshedInFolder.length > 0) {
        setSelectedSessionId(refreshedInFolder[0]!.id)
      }
    },
    [refreshSessions],
  )

  const handleCreateSession = useCallback(async () => {
    setCreatingSession(true)
    try {
      const dir = selectedDirectory || undefined
      const created = await createSession(dir)
      experimentTelemetry.onManualSessionCreate(created.id)
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
    setKnownDirectories((prev) => mergeKnownDirectories(prev, [dir]))
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
      const inheritedTabsRaw = tabsSourceId
        ? cloneTaskSegmentTabs(taskSegmentsBySessionId[tabsSourceId] ?? [])
        : []
      const inheritedActiveTabId = tabsSourceId ? activeTaskSegmentBySessionId[tabsSourceId] : undefined
      const inheritedManualSelection = tabsSourceId
        ? Boolean(taskSegmentManuallySelectedBySessionId[tabsSourceId])
        : false
      const forkTabFilter = filterTaskTabsForFork(inheritedTabsRaw, messages, action.messageID, {
        activeTabId: inheritedActiveTabId,
      })
      const inheritedTabs = forkTabFilter.tabs
      const forkActiveTabId = forkTabFilter.activeTabId ?? inheritedActiveTabId

      setForkBusy(true)
      try {
        const { forkCtx } = pending
        let bundle: ForkPanelSnapshotBundle | null = null
        if (forkCtx) {
          try {
            const originPair =
              visibleSubtasks.find(({ subtask }) => subtask.subtask_id === forkCtx.subtaskId) ??
              visibleSubtasks.find(({ sourceIndex }) => sourceIndex === forkCtx.subtaskDisplayIndex)
            const originFlowEndSummary = originPair
              ? buildFlowEndSummary(
                  buildSubtaskCardMetrics(originPair.subtask, messages, originPair.sourceIndex, {
                    nowMs: Date.now(),
                  }),
                  panelAnalysisBySessionId[targetSessionId]?.[forkCtx.subtaskId],
                )
              : undefined
            bundle = await buildForkPanelSnapshotBundle({
              messages,
              visibleSubtasks,
              sessionDirectory: dir,
              forkAnchorMessageId: action.messageID,
              forkAnchorPartId: action.partId,
              sourceParentSessionId: targetSessionId,
              forkCtx,
              originFlowEndSummary,
            })
          } catch {
            /* snapshot optional */
          }
        }

        const forked = await forkSession(targetSessionId, {
          messageID: action.messageID,
          directory: dir,
        })
        experimentTelemetry.onForkComplete(targetSessionId, forked.id)
        if (bundle) {
          saveForkPanelSnapshotBundle(forked.id, bundle)
        }

        const inheritedTabsForWorker = inheritedTabs.map((tab) => {
          const sourceTab =
            inheritedTabsRaw.find(
              (raw) =>
                raw.fromStartUserMessageId === tab.fromStartUserMessageId &&
                raw.fromEndAssistantMessageId === tab.fromEndAssistantMessageId,
            ) ?? inheritedTabsRaw.find((raw) => raw.fromStartUserMessageId === tab.fromStartUserMessageId)
          return {
            taskId: tab.id,
            status: tab.status,
            fromStartUserMessageId: tab.fromStartUserMessageId,
            fromEndAssistantMessageId: tab.fromEndAssistantMessageId,
            toEndAssistantMessageId: tab.toEndAssistantMessageId,
            turnCount: tab.turnCount,
            title: tab.title,
            description: tab.description,
            summary: tab.summary,
            taskSwitchRunDir: tab.taskSwitchRunDir,
            pipelineRunDir: tab.pipelineRunDir,
            provisional: tab.provisional,
            sourceTaskId: sourceTab?.id,
            sourceParentSessionId: targetSessionId,
          }
        })

        const forkMetaForWorker = {
          forkAnchorMessageId: action.messageID,
          sourceParentSessionId: targetSessionId,
          forkedSessionId: forked.id,
          ...(action.partId ? { forkAnchorPartId: action.partId } : {}),
        }

        const list = await refreshSessions([forked.directory])
        setSessions(list)
        setApiConnected(true)
        setSelectedDirectory(normalizeSessionDirectory(forked.directory))
        setSelectedSessionId(forked.id)
        const [forkMsgs, td] = await Promise.all([
          getMessages(forked.id, 'after fork load session', forked.directory),
          getTodos(forked.id, forked.directory),
        ])
        setMessages(forkMsgs)
        setTodos(td)

        if (inheritedTabs.length > 0) {
          const reconciledForkTabs = reconcileTaskTabsWithMessages(inheritedTabs, forkMsgs)
          setTaskSegmentsBySessionId((prev) => ({
            ...prev,
            [forked.id]: reconciledForkTabs,
          }))
          const reconciledActive =
            reconciledForkTabs.find((tab) => tab.id === forkActiveTabId)?.id ??
            reconciledForkTabs[reconciledForkTabs.length - 1]?.id
          if (reconciledActive) {
            setActiveTaskSegmentBySessionId((prev) => ({
              ...prev,
              [forked.id]: reconciledActive,
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
            tabCount: reconciledForkTabs.length,
            droppedTabCount: Math.max(0, inheritedTabsRaw.length - inheritedTabs.length),
            activeTabId: reconciledActive,
            forkAnchorMessageId: action.messageID,
          })
        }

        void inheritForkTaskState({
          sessionId: forked.id,
          sourceParentSessionId: targetSessionId,
          directory: forked.directory,
          forkAnchorMessageId: action.messageID,
          inheritedTabs: inheritedTabsForWorker,
        })
          .then(() =>
            refreshTaskSegmentsFromWorker(forked.id, forkMsgs).catch((err) =>
              console.warn('[VibeTrace][fork task-segments inherit refresh failed]', err),
            ),
          )
          .catch((err) => console.warn('[VibeTrace][fork inherit task-switch state failed]', err))

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
                .then((result) => {
                  applyMemoryWorkerTaskSegments(forked.id, result)
                  window.setTimeout(() => {
                    void refreshTaskSegmentsFromWorker(forked.id, forkMsgs).catch((err) =>
                      console.warn('[VibeTrace][fork task-segments prompt refresh failed]', err),
                    )
                  }, 1800)
                })
                .catch((err) => console.warn('[VibeTrace][fork task-switch prompt failed]', err))
              experimentTelemetry.onConversationTurn(forked.id)
              experimentTelemetry.onAgentTurnStart(forked.id)
              await sendMessage(forked.id, guidedUserText, forked.directory, {
                model: composerModelRef.trim() || resolveVibeTraceDefaultModelRef(),
              })
              const msgsAfterSend = await getMessages(
                forked.id,
                'after fork first user message',
                forked.directory,
              )
              setMessages(msgsAfterSend)
              const lastFork = msgsAfterSend[msgsAfterSend.length - 1]
              if (lastFork?.info.role === 'user') {
                const gen = abortGenerationRef.current
                setWaitingForAssistantReply(true)
                try {
                  await pollUntilAssistantMessage(
                    forked.id,
                    forked.directory,
                    () =>
                      selectedSessionIdRef.current === forked.id &&
                      abortGenerationRef.current === gen,
                    setMessages,
                  )
                } finally {
                  if (abortGenerationRef.current === gen) {
                    experimentTelemetry.onAgentTurnEnd(forked.id)
                    setWaitingForAssistantReply(false)
                  }
                }
              } else {
                experimentTelemetry.onAgentTurnEnd(forked.id)
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
    [selectedSessionId, sessions, activeSessionDirectory, messages, visibleSubtasks, panelAnalysisBySessionId, refreshSessions, composerModelRef, applyMemoryWorkerTaskSegments, refreshTaskSegmentsFromWorker, taskSegmentsBySessionId, activeTaskSegmentBySessionId, taskSegmentManuallySelectedBySessionId],
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
        sessionListWidth={sidebarSessionListWidth}
        isResizingSessionList={isResizingSidebarSessionList}
        onSessionListResizePointerDown={handleSidebarSessionListResizePointerDown}
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
          cursor: isResizingSubtaskPanel || isResizingSidebarSessionList ? 'col-resize' : undefined,
        }}
      >
        <div
          data-exp-focus="chat-column"
          style={{
            flex: '1 1 auto',
            minWidth: MESSAGE_PANEL_MIN_WIDTH,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
          onPointerEnter={() => experimentTelemetry.enterPanelFocus('chat')}
          onPointerLeave={() => experimentTelemetry.leavePanelFocus('chat')}
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
              latestTodos={latestActiveForPanel}
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
              onTodoPanelClick={handleTodoPanelClick}
              onSessionTitleCommit={handleSessionTitleCommit}
              pendingQuestion={
                selectedSessionId ? pendingQuestions[selectedSessionId] ?? null : null
              }
              onQuestionReply={handleQuestionReply}
              onQuestionReject={handleQuestionReject}
              questionSubmitting={questionSubmitting}
              pendingPermission={
                headPendingPermission(selectedSessionId)
              }
              onPermissionReply={handlePermissionReply}
              permissionSubmitting={permissionSubmitting}
              pendingPermissionQueueSize={
                selectedSessionId
                  ? pendingPermissionQueues[selectedSessionId]?.length ?? 0
                  : 0
              }
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
          data-exp-focus="trajectory-column"
          style={{
            width: subtaskPanelWidth,
            flex: `0 0 ${subtaskPanelWidth}px`,
            minWidth: 0,
            background: '#FFFFFF',
            display: 'flex',
            flexDirection: 'column',
            transition: isResizingSubtaskPanel ? 'none' : 'width 0.15s ease',
          }}
          onPointerEnter={() => experimentTelemetry.enterPanelFocus('trajectory')}
          onPointerLeave={() => experimentTelemetry.leavePanelFocus('trajectory')}
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    setSubtaskFlowLayoutMode('timeline')
                    experimentTelemetry.onTrajectoryClick(selectedSessionId || undefined, { layout: 'timeline' })
                  }}
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
                  onClick={() => {
                    setSubtaskFlowLayoutMode('summary')
                    experimentTelemetry.onTrajectoryClick(selectedSessionId || undefined, { layout: 'summary' })
                  }}
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
              padding: `12px 14px ${MAIN_COLUMN_BOTTOM_INSET_PX}px`,
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
              onPanelSealed={handlePanelSealed}
              onPanelBecameVisible={handlePanelBecameVisible}
              pendingPermission={
                headPendingPermission(selectedSessionId)
              }
              permissionTraces={
                selectedSessionId ? permissionTracesBySessionId[selectedSessionId] ?? [] : []
              }
              recentCompaction={
                selectedSessionId ? sessionCompactions[selectedSessionId] ?? null : null
              }
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
          onPanelSealed={handlePanelSealed}
          onPanelBecameVisible={handlePanelBecameVisible}
          pendingPermission={
            headPendingPermission(selectedSessionId)
          }
          permissionTraces={
            selectedSessionId ? permissionTracesBySessionId[selectedSessionId] ?? [] : []
          }
          recentCompaction={
            selectedSessionId ? sessionCompactions[selectedSessionId] ?? null : null
          }
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
