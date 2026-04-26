import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { OcSession } from './types/opencode'
import {
  getCurrentWorkspaceDirectory,
  getProjectDirectories,
  getSessions,
  getTodos,
  getMessages,
  sendMessage,
  abortSession,
  forkSession,
  createSession,
  updateSessionTitle,
  deleteSession,
  replyToQuestion,
  rejectQuestion,
  subscribeGlobalEvents,
  subscribeWorkspaceEvents,
} from './services/opencodeApi'
import {
  normalizeSessionDirectory,
  uniqueDirectoriesFromSessions,
} from './utils/sessionFolders'
import type { MappedAction, OcMessage, OcPendingQuestionRequest, OcTodo } from './types/opencode'
import type { MessageSendPayload } from './components/MessageInput'
import Sidebar from './components/Sidebar'
import MessagePanel from './components/MessagePanel'
import SubtaskDebugPanel from './components/SubtaskDebugPanel'
import FullscreenSubtaskPanel from './components/FullscreenSubtaskPanel'
import ActionAnalysisModal from './components/ActionAnalysisModal'
import ForkSessionModal from './components/ForkSessionModal'
import SubtaskMessageConnector from './components/SubtaskMessageConnector'
import { groupAssistantSubtasks, isTodoWriteMessage } from './utils/subtaskGrouping'
import { buildMappedActionsFromMessages } from './utils/actionMapping'
import {
  findSubtaskIndexForTodo,
  subtaskShouldUseTodoLink,
} from './utils/subtaskLinkage'
import {
  archivedCompletedList,
  buildSessionTodoModel,
  getLatestTodowriteBatchProgress,
} from './utils/todoRegistry'
import { buildUserMessageWithGuidance } from './config/harnessGuidance'
import {
  buildForkPanelSnapshotBundle,
  getForkPanelSnapshotBundle,
  saveForkPanelSnapshotBundle,
  type ForkFromActionContext,
  type ForkPanelSnapshotBundle,
} from './utils/forkPanelSnapshot'

/** 每条「含 todo 写入」的 message 下标 → 当时同步到的 todos（用于重放 diff） */
type TodosSnapshotMap = Record<string, OcTodo[]>
const AUTO_ABORT_STUCK_RUNNING_AFTER_MS = 24 * 60 * 60 * 1000

/** 发送后若 SSE 未及时刷新，轮询 GET /message 直到出现助手消息（与 OpenCode 流式/长耗时兼容） */
const POLL_ASSISTANT_INTERVAL_MS = 2000
const POLL_ASSISTANT_MAX_ROUNDS = 90
const MANUAL_DIRS_KEY = 'cockpit.manual.directories.v1'
const CLOSED_DIRS_KEY = 'cockpit.closed.directories.v1'

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
    const raw = window.localStorage.getItem(MANUAL_DIRS_KEY)
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
    const raw = window.localStorage.getItem(CLOSED_DIRS_KEY)
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
      const msgs = await getMessages(sessionId, `轮询等待助手回复 ${i + 1}`, directory)
      onMessages(msgs)
      const last = msgs[msgs.length - 1]
      if (last?.info.role === 'assistant') return
    } catch (e) {
      console.warn('[pollUntilAssistantMessage]', e)
    }
  }
}

function formatMessageForConsole(msg: OcMessage | undefined, index: number) {
  if (!msg) {
    return { index, missing: true as const }
  }
  const partsSummary = msg.parts.map(p => {
    switch (p.type) {
      case 'text':
        return { type: 'text' as const, textLen: (p.text || '').length }
      case 'reasoning':
        return { type: 'reasoning' as const, textLen: (p.text || '').length }
      case 'tool':
        return { type: 'tool' as const, tool: p.tool, status: p.state?.status }
      case 'text-file':
        return { type: 'text-file' as const, path: p.path }
      case 'image':
        return { type: 'image' as const }
      case 'step-start':
        return { type: 'step-start' as const }
      case 'step-finish':
        return { type: 'step-finish' as const, reason: p.reason }
      case 'compaction':
        return { type: 'compaction' as const }
      default:
        return { type: 'unknown' as const }
    }
  })
  return {
    index,
    id: msg.info.id,
    role: msg.info.role,
    userContent: msg.info.role === 'user' ? msg.info.content : undefined,
    partsCount: msg.parts.length,
    partsSummary,
    time: msg.info.time,
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
    } catch (e) {
      console.warn('[fetchSessionsAcrossDirectories] skip directory due to error:', dir, e)
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
  /** 递增以驱动 Todo 面板在选中子任务时自动展开到正确分区 */
  const [todoPanelRevealGeneration, setTodoPanelRevealGeneration] = useState(0)
  const [selectedDirectory, setSelectedDirectory] = useState<string>('')
  const [projectDirectories, setProjectDirectories] = useState<string[]>([])
  const [manualDirectories, setManualDirectories] = useState<string[]>(() => loadManualDirectories())
  const [closedDirectories, setClosedDirectories] = useState<string[]>(() => loadClosedDirectories())
  const [creatingSession, setCreatingSession] = useState(false)
  /** 按 sessionID 保存待作答的 question 请求（SSE `question.asked`） */
  const [pendingQuestions, setPendingQuestions] = useState<Record<string, OcPendingQuestionRequest>>({})
  const [questionSubmitting, setQuestionSubmitting] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [analysisAction, setAnalysisAction] = useState<(MappedAction & { row: number }) | null>(null)
  /** Fork：先弹窗填说明，再采集子任务面板快照并调用 OpenCode fork */
  const [pendingFork, setPendingFork] = useState<{
    action: MappedAction & { row: number }
    forkCtx?: ForkFromActionContext
  } | null>(null)
  const [forkBusy, setForkBusy] = useState(false)
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null)
  /** 已发出用户消息但尚未在列表里看到助手收尾（轮询中） */
  const [waitingForAssistantReply, setWaitingForAssistantReply] = useState(false)

  const pendingForkRef = useRef(pendingFork)
  pendingForkRef.current = pendingFork

  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  const refreshSessions = useCallback(
    async (extraDirectories?: Array<string | undefined>) => {
      const base = await getSessions()
      const discovered = await getProjectDirectories().catch((e) => {
        console.warn('[refreshSessions] getProjectDirectories failed:', e)
        return [] as string[]
      })
      const current = await getCurrentWorkspaceDirectory().catch((e) => {
        console.warn('[refreshSessions] getCurrentWorkspaceDirectory failed:', e)
        return null
      })
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
    window.localStorage.setItem(MANUAL_DIRS_KEY, JSON.stringify(manualDirectories))
  }, [manualDirectories])

  useEffect(() => {
    window.localStorage.setItem(CLOSED_DIRS_KEY, JSON.stringify(closedDirectories))
  }, [closedDirectories])

  const sessionsInFolder = useMemo(() => {
    return sessions
      .filter(s => sameDirectory(s.directory, selectedDirectory))
      .sort((a, b) => b.time.updated - a.time.updated)
  }, [sessions, selectedDirectory])

  const linkAreaRef = useRef<HTMLDivElement>(null)
  const messageScrollRef = useRef<HTMLDivElement>(null)
  const todoPanelScrollRef = useRef<HTMLDivElement>(null)
  const subtaskScrollRef = useRef<HTMLDivElement>(null)
  const selectedSessionIdRef = useRef(selectedSessionId)
  selectedSessionIdRef.current = selectedSessionId

  const pendingQuestionsRef = useRef(pendingQuestions)
  pendingQuestionsRef.current = pendingQuestions
  const autoAbortedRunningKeysRef = useRef<Set<string>>(new Set())

  const activeSessionDirectory = useMemo(
    () => sessions.find(s => s.id === selectedSessionId)?.directory,
    [sessions, selectedSessionId],
  )

  /** Fork 后新 session：本地保存的「fork 前」子任务面板可视化快照（仅对比，不进上下文） */
  const forkPanelSnapshotBundle = useMemo(
    () => getForkPanelSnapshotBundle(selectedSessionId),
    [selectedSessionId],
  )

  /** 子任务 Packing View 全屏开关（独立的 dialog 模式） */
  const [subtaskFullscreenOpen, setSubtaskFullscreenOpen] = useState(false)
  /** 子任务面板扩展模式：原地拉宽，每张卡片左侧出 treemap，并接管联动 */
  const [subtaskPanelExpanded, setSubtaskPanelExpanded] = useState(false)
  /** 右侧子任务面板全局布局模式（作用于所有子任务卡） */
  const [subtaskFlowLayoutMode, setSubtaskFlowLayoutMode] = useState<'timeline' | 'packing'>('timeline')
  /**
   * 联动选中：
   *   - kind 'type'   → 高亮整个 actionType 的所有 action（treemap cell + 所有同类 rect）
   *   - kind 'action' → 仅高亮单个 action（treemap 该 mini-block + 该 rect）
   * subtaskIndex 之外的子任务全部 dim。
   */
  const [selection, setSelection] = useState<
    | { kind: 'type'; subtaskIndex: number; actionType: string }
    | { kind: 'action'; subtaskIndex: number; actionKey: string; source: 'treemap' | 'flow' }
    | null
  >(null)
  const handleSelectActionType = useCallback(
    (subtaskIndex: number, actionType: string | null) => {
      setSelection((prev) => {
        if (actionType === null) return null
        if (
          prev &&
          prev.kind === 'type' &&
          prev.subtaskIndex === subtaskIndex &&
          prev.actionType === actionType
        ) {
          return null
        }
        return { kind: 'type', subtaskIndex, actionType }
      })
      /** treemap / rect 选中同一子任务 → 同步触发 todo 高亮联动（与点击子任务卡片一致） */
      if (actionType !== null) setLinkedSubtaskIndex(subtaskIndex)
    },
    [],
  )
  const handleSelectAction = useCallback(
    (subtaskIndex: number, actionKey: string | null, source: 'treemap' | 'flow' = 'treemap') => {
      setSelection((prev) => {
        if (actionKey === null) return null
        if (
          prev &&
          prev.kind === 'action' &&
          prev.subtaskIndex === subtaskIndex &&
          prev.actionKey === actionKey &&
          prev.source === source
        ) {
          return null
        }
        return { kind: 'action', subtaskIndex, actionKey, source }
      })
      if (actionKey !== null) setLinkedSubtaskIndex(subtaskIndex)
    },
    [],
  )

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

  /** 当前选中的 session 已从列表消失时，回退到同文件夹或全局最新；文件夹内无会话且未选中时保持空白 */
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
  }, [selectedSessionId])

  // Subscribe to global SSE events
  useEffect(() => {
    const unsubscribe = subscribeGlobalEvents((event) => {
      const payload = event?.payload || event
      const eventType = payload?.type
      if (!eventType) return

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
          getMessages(sid, `SSE:${eventType}`, dir)
            .then(setMessages)
            .catch((err) => console.warn('[SSE] Failed to refresh messages:', err))
        }
      }

      if (eventType.startsWith('message') || eventType.startsWith('session')) {
        console.log('[OpenCode · App] SSE 事件触发刷新消息列表', eventType)
        const root = event as { directory?: string }
        const eventDir = typeof root.directory === 'string' ? root.directory : undefined
        refreshSessions(eventDir ? [eventDir] : undefined)
          .then(setSessions)
          .catch(err => console.warn('[SSE] Failed to refresh sessions:', err))
        const dir = sessionsRef.current.find(s => s.id === selectedSessionId)?.directory
        if (selectedSessionId) {
          getMessages(selectedSessionId, `SSE:${eventType}`, dir)
            .then(setMessages)
            .catch(err => console.warn('[SSE] Failed to refresh messages:', err))
        }
      }

      if (eventType.startsWith('todo')) {
        const dir = sessionsRef.current.find(s => s.id === selectedSessionId)?.directory
        if (selectedSessionId) {
          getTodos(selectedSessionId, dir)
            .then(setTodos)
            .catch(err => console.warn('[SSE] Failed to refresh todos:', err))
        }
      }
    })

    return unsubscribe
  }, [selectedSessionId, refreshSessions])

  // 并行监听当前 workspace 的 GET /event（仅控制台有输出；handler 空避免与 global 重复刷新 UI）
  useEffect(() => {
    return subscribeWorkspaceEvents(() => {})
  }, [])

  // Load messages + todos when session changes
  const loadSessionData = useCallback(async (sessionId: string, directory?: string) => {
    if (!sessionId) return
    setLoading(true)
    try {
      const [msgs, td] = await Promise.all([
        getMessages(sessionId, '进入会话/切换 session 首次加载', directory),
        getTodos(sessionId, directory),
      ])
      setMessages(msgs)
      setTodos(td)
    } catch (err) {
      console.error('Failed to load session data:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSessionData(selectedSessionId, activeSessionDirectory)
  }, [selectedSessionId, activeSessionDirectory, loadSessionData])

  /** 对于超过 24h 且无后续 assistant 消息收口的 running/pending tool，自动 abort 会话（每条 call 只触发一次）。 */
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
      } catch (err) {
        console.warn('[auto-abort stuck running] failed:', err)
        autoAbortedRunningKeysRef.current.delete(runKey)
      } finally {
        setAborting(false)
      }
    })()
  }, [messages, selectedSessionId, aborting, refreshSessions])

  useEffect(() => {
    setTodosSnapshotAtMessageIndex({})
  }, [selectedSessionId])

  // 为「当前最后一条 todo-write message」保存 todos 快照，便于重算分组时做 completed diff（历史较早的写入若无快照则为空）
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
   * 右栏子任务：与 `groupAssistantSubtasks` 结果一一对应并全部展示（含尚无 todowrite 的前期调研段）。
   */
  const visibleSubtasks = useMemo(
    () => assistantSubtasks.map((subtask, sourceIndex) => ({ subtask, sourceIndex })),
    [assistantSubtasks],
  )

  /** execution 子任务：用 todo id 高亮 */
  const linkedTodoIds = useMemo(() => {
    if (linkedSubtaskIndex === null) return null
    const st = assistantSubtasks[linkedSubtaskIndex]
    if (!st || !subtaskShouldUseTodoLink(st)) return null
    return new Set(st.linkedTodoIds)
  }, [linkedSubtaskIndex, assistantSubtasks])

  useEffect(() => {
    if (messages.length === 0) return
    const payload = assistantSubtasks.map((st, si) => {
      const segmentIndices = [
        ...(st.userMessageIndices ?? []),
        ...st.assistantMessageIndices,
      ].sort((a, b) => a - b)
      const segmentMsgs = segmentIndices
        .map(i => messages[i])
        .filter((m): m is OcMessage => m != null)
      return {
        segmentIndex: si,
        phase: st.phase,
        subtask_id: st.subtask_id,
        todos: st.todos,
        todosNewlyCompleted: st.todosNewlyCompleted,
        linkedTodoIds: st.linkedTodoIds,
        userMessageIndices: st.userMessageIndices,
        assistantMessageIndices: st.assistantMessageIndices,
        messages: segmentIndices.map(i => formatMessageForConsole(messages[i], i)),
        flowActions: buildMappedActionsFromMessages(segmentMsgs),
      }
    })
    console.log('[AssistantSubtasks]', payload)
  }, [assistantSubtasks, messages])

  const toggleSubtaskLink = useCallback((si: number) => {
    setLinkedSubtaskIndex(prev => (prev === si ? null : si))
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
      const fallback = visibleSubtasks.find(({ subtask }) =>
        subtask.linkedTodoIds.includes(id)
      )
      if (fallback) setLinkedSubtaskIndex(fallback.sourceIndex)
    },
    [assistantSubtasks, visibleSubtasks]
  )

  useEffect(() => {
    setLinkedSubtaskIndex(null)
    setTodoPanelRevealGeneration(0)
    setSelection(null)
  }, [selectedSessionId])

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
    const st = assistantSubtasks[linkedSubtaskIndex]
    if (!st || st.assistantMessageIndices.length === 0) return
    const first = Math.min(...st.assistantMessageIndices)
    requestAnimationFrame(() => {
      messageScrollRef.current
        ?.querySelector(`[data-message-index="${first}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }, [linkedSubtaskIndex, assistantSubtasks])

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
      const msgs = await getMessages(selectedSessionId, 'question 回复后', dir)
      setMessages(msgs)
    } catch (e) {
      console.error('[question reply]', e)
      window.alert(
        '提交答案失败。请确认 OpenCode 已支持 POST /question/{requestID}/reply（OpenCode SDK v2 与 opencode serve 新版本提供该路由）。',
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
      const msgs = await getMessages(selectedSessionId, 'question 拒绝后', dir)
      setMessages(msgs)
    } catch (e) {
      console.error('[question reject]', e)
      window.alert('操作失败。')
    } finally {
      setQuestionSubmitting(false)
    }
  }, [selectedSessionId])

  /** 消息气泡内联 question 提交/跳过后，与底部面板一致：刷新消息并清掉同会话的 SSE pending */
  const handleQuestionAnswered = useCallback(async () => {
    if (!selectedSessionId) return
    const dir = sessionsRef.current.find((s) => s.id === selectedSessionId)?.directory
    try {
      const msgs = await getMessages(selectedSessionId, '内联 question 提交后', dir)
      setMessages(msgs)
    } catch (e) {
      console.error('[handleQuestionAnswered]', e)
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
    // OpenCode 常在「本轮 Agent 跑完」后才返回 POST /message；若在此 await，MessageInput 会一直保持 sending，输入框被禁用。
    // 与 fork 首条消息一致：后台发送，靠 SSE + 完成后拉列表 更新 UI。
    void (async () => {
      try {
        await sendMessage(sid, text, dir, { imageParts: images })
        const msgs = await getMessages(sid, 'POST 发送完成后拉取完整列表', dir)
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
        console.error('[handleSendMessage]', e)
        window.alert(`发送失败：${e instanceof Error ? e.message : String(e)}`)
        setWaitingForAssistantReply(false)
      }
    })()
  }, [selectedSessionId, sessions])

  const handleAbortMessage = useCallback(async () => {
    if (!selectedSessionId) return
    const dir = sessions.find(s => s.id === selectedSessionId)?.directory
    setAborting(true)
    try {
      await abortSession(selectedSessionId, dir)
      const [list, msgs] = await Promise.all([
        refreshSessions(),
        getMessages(selectedSessionId, 'abort 后刷新', dir),
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
    } catch (e) {
      console.error('Failed to create session:', e)
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
          `确定要归档「${label}」吗？\n\n将调用 OpenCode DELETE /session/:id，该会话及其消息会从服务端删除，通常无法恢复。`,
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
        console.error('Failed to archive session:', e)
        window.alert(`归档失败：${e instanceof Error ? e.message : String(e)}`)
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
          } catch (e) {
            console.error('Fork: panel snapshot failed (fork will still run):', e)
          }
        }

        const forked = await forkSession(targetSessionId, {
          messageID: action.messageID,
          directory: dir,
        })
        if (bundle) {
          saveForkPanelSnapshotBundle(forked.id, bundle)
        }

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
          // POST /message 常在本轮 Agent 跑完后才返回；不要 await，否则对话窗要等整轮结束。
          void (async () => {
            try {
              await sendMessage(forked.id, buildUserMessageWithGuidance(userText), forked.directory)
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
              console.error('Fork: first message failed:', err)
              window.alert(
                `Fork 后首条消息发送失败：${err instanceof Error ? err.message : String(err)}\n\n请检查 OpenCode 是否在运行、VITE_OPENCODE_BASE 是否与终端一致，以及控制台 Network 中 POST …/message 是否 200。`,
              )
            }
          })()
        }
        setPendingFork(null)
        setForkBusy(false)
      } catch (e) {
        console.error('Failed to fork session from action:', e)
        setPendingFork(null)
      } finally {
        setForkBusy(false)
      }
    },
    [selectedSessionId, sessions, activeSessionDirectory, messages, visibleSubtasks, refreshSessions],
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
      }}
    >
      {/* 左侧：文件夹窄栏 + 会话列表 */}
      <Sidebar
        sessionsInFolder={sessionsInFolder}
        directories={directories}
        selectedDirectory={selectedDirectory}
        onSelectDirectory={handleSelectDirectory}
        selectedSessionId={selectedSessionId}
        onSelectSession={setSelectedSessionId}
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

      {/* 中栏 + 右栏：同一相对定位容器，便于子任务与消息连线 */}
      <div
        ref={linkAreaRef}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'row',
          position: 'relative',
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
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
            />
          </div>
        </div>

        <div
          style={{
            width: subtaskPanelExpanded ? 'min(70vw, 1260px)' : 630,
            flexShrink: 0,
            background: '#FFFFFF',
            borderLeft: '1px solid #E8E8E8',
            display: 'flex',
            flexDirection: 'column',
            transition: 'width 0.25s ease',
          }}
        >
          <div
            style={{
              height: 44,
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span>Agent Action Visualization</span>
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
                  onClick={() => setSubtaskFlowLayoutMode('packing')}
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
                    color: subtaskFlowLayoutMode === 'packing' ? '#2B2B2B' : '#A3A3A3',
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 3,
                      boxSizing: 'border-box',
                      background: subtaskFlowLayoutMode === 'packing' ? '#C6C6C6' : 'transparent',
                      border:
                        subtaskFlowLayoutMode === 'packing'
                          ? '1px solid #8A8A8A'
                          : '1px solid #C6C6C6',
                    }}
                  />
                  packing
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                onClick={() => {
                  setSubtaskPanelExpanded((v) => !v)
                  if (subtaskPanelExpanded) setSelection(null)
                }}
                aria-label={subtaskPanelExpanded ? '收起 Overview' : '展开 Overview'}
                title={subtaskPanelExpanded ? '收起 Overview' : '展开 Overview（拉宽面板 + Treemap + 联动）'}
                disabled={visibleSubtasks.length === 0}
                style={{
                  width: 26,
                  height: 26,
                  border: 'none',
                  background: subtaskPanelExpanded ? '#EEF1E5' : 'transparent',
                  cursor: visibleSubtasks.length === 0 ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 6,
                  color: visibleSubtasks.length === 0
                    ? '#C6C6C6'
                    : (subtaskPanelExpanded ? '#5A6B41' : '#5C5C5C'),
                }}
                onMouseEnter={(e) => {
                  if (visibleSubtasks.length === 0) return
                  if (!subtaskPanelExpanded) e.currentTarget.style.background = '#F3F3F3'
                }}
                onMouseLeave={(e) => {
                  if (!subtaskPanelExpanded) e.currentTarget.style.background = 'transparent'
                }}
              >
                {subtaskPanelExpanded ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h6v6" />
                    <path d="M9 21H3v-6" />
                    <path d="M21 3l-7 7" />
                    <path d="M3 21l7-7" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 3H3v6" />
                    <path d="M15 21h6v-6" />
                    <path d="M3 3l7 7" />
                    <path d="M21 21l-7-7" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                onClick={() => setSubtaskFullscreenOpen(true)}
                aria-label="全屏 Packing View"
                title="全屏 Packing View"
                disabled={visibleSubtasks.length === 0}
                style={{
                  width: 26,
                  height: 26,
                  border: 'none',
                  background: 'transparent',
                  cursor: visibleSubtasks.length === 0 ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 6,
                  color: visibleSubtasks.length === 0 ? '#C6C6C6' : '#5C5C5C',
                }}
                onMouseEnter={(e) => {
                  if (visibleSubtasks.length === 0) return
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
              padding: '12px 14px',
              gap: 12,
            }}
          >
            <SubtaskDebugPanel
              messages={messages}
              visibleSubtasks={visibleSubtasks}
              linkedSubtaskIndex={linkedSubtaskIndex}
              onSelectSubtask={toggleSubtaskLink}
              onForkFromAction={handleForkFromAction}
              onAnalyzeFromAction={handleAnalyzeFromAction}
              listScrollRef={subtaskScrollRef}
              sessionDirectory={activeSessionDirectory}
              forkPanelSnapshotBundle={forkPanelSnapshotBundle}
              leadingTreemapSize={subtaskPanelExpanded ? 200 : undefined}
              flowLayoutMode={subtaskFlowLayoutMode}
              selection={selection}
              onSelectActionType={handleSelectActionType}
              onSelectAction={handleSelectAction}
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
          todoPanelScrollRef={todoPanelScrollRef}
          subtaskScrollRef={subtaskScrollRef}
          subtaskIndex={linkedSubtaskIndex}
          linkedTodoIds={linkedTodoIds}
        />
        {analysisAction ? (
          <ActionAnalysisModal action={analysisAction} onClose={() => setAnalysisAction(null)} />
        ) : null}

        <FullscreenSubtaskPanel
          open={subtaskFullscreenOpen}
          onClose={() => setSubtaskFullscreenOpen(false)}
          messages={messages}
          visibleSubtasks={visibleSubtasks}
          linkedSubtaskIndex={linkedSubtaskIndex}
          onSelectSubtask={toggleSubtaskLink}
          onForkFromAction={handleForkFromAction}
          onAnalyzeFromAction={handleAnalyzeFromAction}
          sessionDirectory={activeSessionDirectory}
          forkPanelSnapshotBundle={forkPanelSnapshotBundle}
        />
      </div>
    </div>
  )
}

export default App
