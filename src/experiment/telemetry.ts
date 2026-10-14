import { STORAGE_KEYS } from '../config/storageKeys'
import { directoryKey, normalizeSessionDirectory } from '../utils/sessionFolders'
import {
  emptyCounters,
  emptyFirstInteractionAt,
  EXPERIMENT_FOCUS_PANELS,
  EXPERIMENT_REGIONS,
  FOCUS_PANEL_COUNTER_KEY,
  totalFocusMs,
  VIBETRACE_FOCUS_PANELS,
  type ExperimentCounters,
  type ExperimentEvent,
  type ExperimentEventName,
  type ExperimentFocusPanel,
  type ExperimentRegion,
  type ExperimentReport,
  type ExperimentSnapshot,
  type FirstInteractionAt,
  type PanelFocusShares,
  type SolvePhaseFocusMs,
} from './types'

const IDLE_GAP_CAP_MS = 5 * 60 * 1000

const INTERACTIVE_EVENTS = new Set<ExperimentEventName>([
  'chat.turn',
  'chat.scroll',
  'trajectory.scroll',
  'trajectory.click',
  'todo.panel_click',
  'todo.click',
  'tooltip.action',
  'tooltip.flow_end_summary',
  'panel.view',
  'trajectory.view',
  'skill.panel_click',
  'task_tab.select',
  'fork.complete',
  'skill.distill',
  'panel.focus',
  'session.create',
  'agent.turn_start',
  'agent.turn_end',
])

const LS_KEY = STORAGE_KEYS.experimentActive
const MAX_EVENTS = 2000

type Listener = (snap: ExperimentSnapshot | null) => void

type StoredActiveV2 = {
  v: 2 | 3
  /** One Start for the whole study; switching workspaces auto-opens a per-folder bucket. */
  studyActive?: boolean
  participantId?: string
  byDirectory: Record<string, ExperimentSnapshot>
}

type LoadedStore = {
  studyActive: boolean
  participantId: string
  byDirectory: Map<string, ExperimentSnapshot>
}

function nowIso(): string {
  return new Date().toISOString()
}

function newId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}_${rand}`
}

function normalizeSnap(parsed: ExperimentSnapshot): ExperimentSnapshot {
  return {
    ...parsed,
    counters: { ...emptyCounters(), ...parsed.counters },
    firstInteractionAt: {
      ...emptyFirstInteractionAt(),
      ...(parsed.firstInteractionAt || {}),
    },
    sessionIds: Array.isArray(parsed.sessionIds) ? parsed.sessionIds : [],
    seenTrajectoryIds: Array.isArray(parsed.seenTrajectoryIds) ? parsed.seenTrajectoryIds : [],
    seenTaskTabIds: Array.isArray(parsed.seenTaskTabIds) ? parsed.seenTaskTabIds : [],
    seenSubtaskIds: Array.isArray(parsed.seenSubtaskIds) ? parsed.seenSubtaskIds : [],
    events: Array.isArray(parsed.events) ? parsed.events : [],
    focusStartedAt: null,
    focusPanel: null,
    firstUserTurnAt:
      typeof parsed.firstUserTurnAt === 'string' && parsed.firstUserTurnAt
        ? parsed.firstUserTurnAt
        : null,
    lastResultAt:
      typeof parsed.lastResultAt === 'string' && parsed.lastResultAt ? parsed.lastResultAt : null,
    lastConversationEndAt:
      typeof parsed.lastConversationEndAt === 'string' && parsed.lastConversationEndAt
        ? parsed.lastConversationEndAt
        : null,
    agentWorkStartedAt: null,
  }
}

function emptyPhaseFocus(): Record<ExperimentFocusPanel, number> {
  return {
    chat: 0,
    todo: 0,
    session: 0,
    task: 0,
    trajectory: 0,
    skill: 0,
    tooltip: 0,
  }
}

function emptySolvePhaseFocusMs(): SolvePhaseFocusMs {
  return {
    early: emptyPhaseFocus(),
    mid: emptyPhaseFocus(),
    late: emptyPhaseFocus(),
  }
}

function isFocusPanel(value: unknown): value is ExperimentFocusPanel {
  return typeof value === 'string' && (EXPERIMENT_FOCUS_PANELS as string[]).includes(value)
}

function vibetraceShareFromMs(byPanel: Record<ExperimentFocusPanel, number>): number | null {
  let total = 0
  let vibe = 0
  for (const panel of EXPERIMENT_FOCUS_PANELS) {
    const ms = byPanel[panel] || 0
    total += ms
    if (VIBETRACE_FOCUS_PANELS.includes(panel)) vibe += ms
  }
  return total > 0 ? vibe / total : null
}

function buildTimelineDerived(
  events: ExperimentEvent[],
  startedAt: string,
  durationMs: number,
  counters: ExperimentCounters,
  snapHints?: {
    firstUserTurnAt?: string | null
    lastResultAt?: string | null
    lastConversationEndAt?: string | null
  },
) {
  const systemFocusMs = totalFocusMs(counters)
  const agentWorkMs = Math.max(0, counters.agentWorkMs || 0)
  const startedMs = Date.parse(startedAt)
  const sorted = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))

  let firstUserTurnAt =
    snapHints?.firstUserTurnAt ||
    sorted.find((e) => e.event === 'chat.turn' || e.event === 'agent.turn_start')?.ts ||
    null
  const firstUserTurnMs =
    firstUserTurnAt && Number.isFinite(startedMs)
      ? Math.max(0, Date.parse(firstUserTurnAt) - startedMs)
      : null

  // Prefer explicit agent.turn_end; fall back to snapshot hint.
  const turnEnds = sorted.filter((e) => e.event === 'agent.turn_end').map((e) => e.ts)
  let lastConversationEndAt: string | null =
    snapHints?.lastConversationEndAt ||
    (turnEnds.length > 0 ? turnEnds[turnEnds.length - 1]! : null)

  // If we have paired start/end in the log, also sum durations as a cross-check fallback
  // when counter was not persisted (legacy exports).
  let agentWorkFromEvents = 0
  const starts = sorted.filter((e) => e.event === 'agent.turn_start')
  for (const start of starts) {
    const t0 = Date.parse(start.ts)
    const end = sorted.find(
      (e) => e.event === 'agent.turn_end' && Date.parse(e.ts) >= t0,
    )
    if (!end) continue
    const ms = Number(end.props?.ms)
    agentWorkFromEvents += Number.isFinite(ms)
      ? Math.max(0, ms)
      : Math.max(0, Date.parse(end.ts) - t0)
  }
  const resolvedAgentWorkMs = agentWorkMs > 0 ? agentWorkMs : agentWorkFromEvents

  const conversationSpanMs =
    firstUserTurnAt && lastConversationEndAt
      ? Math.max(0, Date.parse(lastConversationEndAt) - Date.parse(firstUserTurnAt))
      : null

  let solveEndAt: string | null = snapHints?.lastResultAt || null
  if (firstUserTurnAt) {
    const t0 = Date.parse(firstUserTurnAt)
    const gens = sorted
      .filter((e) => e.event === 'subtask.generated')
      .map((e) => e.ts)
      .filter((ts) => Date.parse(ts) >= t0)
    if (gens.length > 0) solveEndAt = gens[gens.length - 1]!
  } else {
    const gens = sorted.filter((e) => e.event === 'subtask.generated')
    if (gens.length > 0) solveEndAt = gens[gens.length - 1]!.ts
  }

  const solveDurationMs =
    firstUserTurnAt && solveEndAt
      ? Math.max(0, Date.parse(solveEndAt) - Date.parse(firstUserTurnAt))
      : null

  const interactiveTs = sorted
    .filter((e) => INTERACTIVE_EVENTS.has(e.event))
    .map((e) => Date.parse(e.ts))
    .filter((t) => Number.isFinite(t))
  let activeSpanMs: number | null = null
  let idleCappedActiveMs: number | null = null
  if (interactiveTs.length >= 2) {
    activeSpanMs = Math.max(0, interactiveTs[interactiveTs.length - 1]! - interactiveTs[0]!)
    let capped = 0
    for (let i = 1; i < interactiveTs.length; i++) {
      capped += Math.min(IDLE_GAP_CAP_MS, interactiveTs[i]! - interactiveTs[i - 1]!)
    }
    idleCappedActiveMs = capped
  } else if (interactiveTs.length === 1) {
    activeSpanMs = 0
    idleCappedActiveMs = 0
  }

  // Conversation window for panel-phase analysis: prefer last conversation end.
  const windowEndAt = lastConversationEndAt || solveEndAt
  const solvePhaseFocusMs = emptySolvePhaseFocusMs()
  let focusDuringSolveMs: number | null = null
  let focusDuringSolveShares: PanelFocusShares | null = null
  let vibetraceFocusShareDuringSolve: number | null = null
  let solvePhaseVibetraceShare: Record<'early' | 'mid' | 'late', number | null> | null = null

  if (firstUserTurnAt && windowEndAt) {
    const win0 = Date.parse(firstUserTurnAt)
    const win1 = Date.parse(windowEndAt)
    const span = Math.max(1, win1 - win0)
    const during = emptyPhaseFocus()
    for (const e of sorted) {
      if (e.event !== 'panel.focus') continue
      const t = Date.parse(e.ts)
      if (!Number.isFinite(t) || t < win0 || t > win1) continue
      const panelRaw = e.props?.panel
      const panel: ExperimentFocusPanel = isFocusPanel(panelRaw)
        ? panelRaw
        : panelRaw === 'chat'
          ? 'chat'
          : 'trajectory'
      const ms = Math.max(0, Number(e.props?.ms) || 0)
      during[panel] += ms
      const frac = (t - win0) / span
      const phase: 'early' | 'mid' | 'late' = frac < 1 / 3 ? 'early' : frac < 2 / 3 ? 'mid' : 'late'
      solvePhaseFocusMs[phase][panel] += ms
    }
    focusDuringSolveMs = EXPERIMENT_FOCUS_PANELS.reduce((s, p) => s + during[p], 0)
    if (focusDuringSolveMs > 0) {
      focusDuringSolveShares = {} as PanelFocusShares
      for (const p of EXPERIMENT_FOCUS_PANELS) {
        focusDuringSolveShares[p] = during[p] / focusDuringSolveMs
      }
      vibetraceFocusShareDuringSolve = vibetraceShareFromMs(during)
      solvePhaseVibetraceShare = {
        early: vibetraceShareFromMs(solvePhaseFocusMs.early),
        mid: vibetraceShareFromMs(solvePhaseFocusMs.mid),
        late: vibetraceShareFromMs(solvePhaseFocusMs.late),
      }
    } else {
      focusDuringSolveMs = 0
      focusDuringSolveShares = {
        chat: null,
        todo: null,
        session: null,
        task: null,
        trajectory: null,
        skill: null,
        tooltip: null,
      }
    }
  }

  return {
    systemFocusMs,
    systemFocusWallShare: durationMs > 0 ? systemFocusMs / durationMs : null,
    firstUserTurnAt,
    firstUserTurnMs,
    lastConversationEndAt,
    conversationSpanMs,
    agentWorkMs: resolvedAgentWorkMs,
    agentWorkShareOfConversation:
      conversationSpanMs && conversationSpanMs > 0
        ? resolvedAgentWorkMs / conversationSpanMs
        : null,
    solveEndAt,
    solveDurationMs,
    activeSpanMs,
    idleCappedActiveMs,
    focusDuringSolveMs,
    focusDuringSolveShares,
    vibetraceFocusShareDuringSolve,
    solvePhaseFocusMs: focusDuringSolveMs && focusDuringSolveMs > 0 ? solvePhaseFocusMs : null,
    solvePhaseVibetraceShare,
  }
}

function loadStore(): LoadedStore {
  const byDirectory = new Map<string, ExperimentSnapshot>()
  let studyActive = false
  let participantId = 'P01'
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { studyActive, participantId, byDirectory }
    const parsed = JSON.parse(raw) as StoredActiveV2 | ExperimentSnapshot
    if (
      parsed &&
      typeof parsed === 'object' &&
      ((parsed as StoredActiveV2).v === 2 || (parsed as StoredActiveV2).v === 3)
    ) {
      const stored = parsed as StoredActiveV2
      const by = stored.byDirectory || {}
      for (const [key, snap] of Object.entries(by)) {
        if (!snap?.active || !snap.experimentId) continue
        const dirKey = key || directoryKey(snap.directory)
        if (!dirKey) continue
        byDirectory.set(dirKey, normalizeSnap(snap))
      }
      const first = byDirectory.values().next().value as ExperimentSnapshot | undefined
      participantId =
        (typeof stored.participantId === 'string' && stored.participantId.trim()) ||
        first?.participantId ||
        participantId
      studyActive = Boolean(stored.studyActive) || byDirectory.size > 0
      return { studyActive, participantId, byDirectory }
    }
    // Migrate v1 single-snapshot draft
    const legacy = parsed as ExperimentSnapshot
    if (legacy?.active && legacy.experimentId) {
      const key = directoryKey(legacy.directory)
      if (key) {
        byDirectory.set(key, normalizeSnap(legacy))
        studyActive = true
        participantId = legacy.participantId || participantId
      }
    }
  } catch {
    /* ignore */
  }
  return { studyActive, participantId, byDirectory }
}

function persist(store: {
  studyActive: boolean
  participantId: string
  byDirectory: Map<string, ExperimentSnapshot>
}) {
  try {
    if (!store.studyActive && store.byDirectory.size === 0) {
      localStorage.removeItem(LS_KEY)
      return
    }
    const record: Record<string, ExperimentSnapshot> = {}
    for (const [key, snap] of store.byDirectory) {
      record[key] = {
        ...snap,
        focusStartedAt: null,
        focusPanel: null,
      }
    }
    const stored: StoredActiveV2 = {
      v: 3,
      studyActive: store.studyActive,
      participantId: store.participantId,
      byDirectory: record,
    }
    localStorage.setItem(LS_KEY, JSON.stringify(stored))
  } catch {
    /* ignore quota */
  }
}

function buildFirstInteractionDerived(
  startedAt: string,
  first: FirstInteractionAt,
): {
  firstInteractionOrder: ExperimentRegion[]
  firstInteractionMs: Record<ExperimentRegion, number | null>
} {
  const startedMs = Date.parse(startedAt)
  const firstInteractionMs = {} as Record<ExperimentRegion, number | null>
  const timed: { region: ExperimentRegion; ms: number }[] = []
  for (const region of EXPERIMENT_REGIONS) {
    const at = first[region]
    if (!at) {
      firstInteractionMs[region] = null
      continue
    }
    const t = Date.parse(at)
    const ms =
      Number.isFinite(startedMs) && Number.isFinite(t) ? Math.max(0, t - startedMs) : null
    firstInteractionMs[region] = ms
    if (ms != null) timed.push({ region, ms })
  }
  timed.sort((a, b) => a.ms - b.ms)
  return {
    firstInteractionOrder: timed.map((x) => x.region),
    firstInteractionMs,
  }
}

function ratioOrNull(part: number, total: number): number | null {
  return total > 0 ? part / total : null
}

function buildPanelFocusShares(c: ExperimentCounters): PanelFocusShares {
  const focusTotal = totalFocusMs(c)
  const shares = {} as PanelFocusShares
  for (const panel of EXPERIMENT_FOCUS_PANELS) {
    const key = FOCUS_PANEL_COUNTER_KEY[panel]
    shares[panel] = ratioOrNull(c[key] as number, focusTotal)
  }
  return shares
}

function buildDerived(
  c: ExperimentCounters,
  startedAt: string,
  first: FirstInteractionAt,
  events: ExperimentEvent[],
  durationMs: number,
  snapHints?: {
    firstUserTurnAt?: string | null
    lastResultAt?: string | null
    lastConversationEndAt?: string | null
  },
) {
  const scrollTotal = c.chatPanelScrolls + c.trajectoryPanelScrolls
  const rightOps =
    c.trajectoryPanelClicks +
    c.actionTooltipShows +
    c.flowEndSummaryTooltipShows +
    c.todoClicks +
    c.skillPanelClicks
  const leftOps = c.chatPanelScrolls + c.conversationTurns
  const interactionTotal = leftOps + rightOps
  const firstDerived = buildFirstInteractionDerived(startedAt, first)
  const generated = c.subtaskPanelsGenerated
  const panelFocusShares = buildPanelFocusShares(c)
  const timeline = buildTimelineDerived(events, startedAt, durationMs, c, snapHints)
  return {
    chatFocusRatio: panelFocusShares.chat,
    todoFocusRatio: panelFocusShares.todo,
    sessionFocusRatio: panelFocusShares.session,
    taskBarFocusRatio: panelFocusShares.task,
    trajectoryFocusRatio: panelFocusShares.trajectory,
    skillFocusRatio: panelFocusShares.skill,
    tooltipFocusRatio: panelFocusShares.tooltip,
    panelFocusShares,
    chatScrollShare: ratioOrNull(c.chatPanelScrolls, scrollTotal),
    trajectoryInteractionShare: ratioOrNull(rightOps, interactionTotal),
    ...firstDerived,
    panelViewCoverage: generated > 0 ? c.trajectoriesViewed / generated : null,
    ...timeline,
  }
}

function snapToReport(snap: ExperimentSnapshot, notes?: string): ExperimentReport {
  const endedAt = nowIso()
  const startedMs = Date.parse(snap.startedAt)
  const endedMs = Date.parse(endedAt)
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : 0
  return {
    schemaVersion: 'experiment.report.v1',
    participantId: snap.participantId,
    experimentId: snap.experimentId,
    directory: snap.directory,
    startedAt: snap.startedAt,
    endedAt,
    durationMs,
    sessionIds: [...snap.sessionIds],
    counters: { ...snap.counters },
    firstInteractionAt: { ...snap.firstInteractionAt },
    derived: buildDerived(
      snap.counters,
      snap.startedAt,
      snap.firstInteractionAt,
      snap.events,
      durationMs,
      {
        firstUserTurnAt: snap.firstUserTurnAt,
        lastResultAt: snap.lastResultAt,
        lastConversationEndAt: snap.lastConversationEndAt,
      },
    ),
    events: [...snap.events],
    notes: notes?.trim() || undefined,
  }
}

class ExperimentTelemetry {
  private store = loadStore()
  private byDirectory = this.store.byDirectory
  private studyActive = this.store.studyActive
  private participantId = this.store.participantId
  /** directoryKey of the workspace currently shown in the UI — events route here. */
  private currentKey = ''
  private listeners = new Set<Listener>()
  private scrollTimers: Record<string, number | null> = { chat: null, trajectory: null }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.getSnapshot())
    return () => this.listeners.delete(fn)
  }

  private emit() {
    persist({
      studyActive: this.studyActive,
      participantId: this.participantId,
      byDirectory: this.byDirectory,
    })
    const snap = this.getSnapshot()
    for (const fn of this.listeners) fn(snap)
  }

  /**
   * Bind event routing to the workspace the user is viewing.
   * Always-on: selecting a folder starts/continues recording and opens a per-folder bucket.
   */
  setCurrentDirectory(directory: string) {
    const nextKey = directoryKey(directory)
    if (nextKey === this.currentKey) {
      if (nextKey) {
        this.studyActive = true
        if (!this.participantId.trim()) this.participantId = 'P01'
        this.ensureBucketForDirectory(directory)
        this.emit()
      }
      return
    }
    this.flushFocus()
    this.currentKey = nextKey
    if (nextKey) {
      this.studyActive = true
      if (!this.participantId.trim()) this.participantId = 'P01'
      this.ensureBucketForDirectory(directory)
    }
    this.emit()
  }

  /** Resume always-on recording after returning to the tab (localStorage + current folder). */
  resumeIfNeeded(directory: string) {
    if (!directory.trim()) return
    this.setCurrentDirectory(directory)
  }

  setParticipantId(participantId: string) {
    const next = participantId.trim() || 'P01'
    if (next === this.participantId) return
    this.participantId = next
    for (const snap of this.byDirectory.values()) {
      if (snap.active) snap.participantId = next
    }
    this.emit()
  }

  getCurrentDirectoryKey(): string {
    return this.currentKey
  }

  getSnapshot(): ExperimentSnapshot | null {
    if (!this.currentKey) return null
    const snap = this.byDirectory.get(this.currentKey)
    return snap?.active ? snap : null
  }

  /** True when the current workspace folder is recording. */
  isActive(): boolean {
    return Boolean(this.getSnapshot())
  }

  /** True while always-on study is running (auto-starts when a folder is selected). */
  isStudyActive(): boolean {
    return this.studyActive
  }

  getParticipantId(): string {
    return this.participantId
  }

  /** Snapshot every active folder as a report without ending recording. */
  snapshotReports(notes?: string): ExperimentReport[] {
    this.flushFocus()
    const reports: ExperimentReport[] = []
    for (const snap of this.byDirectory.values()) {
      if (!snap.active) continue
      this.flushFocusFor(snap)
      this.flushAgentWorkFor(snap, { checkpoint: true })
      reports.push(snapToReport(snap, notes))
    }
    this.emit()
    return reports
  }

  /** True if any workspace folder still has an active recording. */
  hasAnyActive(): boolean {
    for (const snap of this.byDirectory.values()) {
      if (snap.active) return true
    }
    return false
  }

  private createBucket(directory: string, participantId: string): ExperimentSnapshot {
    const normalized = normalizeSessionDirectory(directory)
    const key = directoryKey(normalized)
    const snap: ExperimentSnapshot = {
      active: true,
      participantId,
      experimentId: newId('exp'),
      directory: normalized,
      startedAt: nowIso(),
      sessionIds: [],
      seenTrajectoryIds: [],
      seenTaskTabIds: [],
      seenSubtaskIds: [],
      counters: emptyCounters(),
      firstInteractionAt: emptyFirstInteractionAt(),
      events: [],
      focusStartedAt: null,
      focusPanel: null,
      firstUserTurnAt: null,
      lastResultAt: null,
      lastConversationEndAt: null,
      agentWorkStartedAt: null,
    }
    this.byDirectory.set(key, snap)
    this.trackOn(snap, 'experiment.start', undefined, { participantId, directory: normalized })
    return snap
  }

  /** Open a per-folder draft if the study is running and this workspace has none yet. */
  private ensureBucketForDirectory(directory: string): ExperimentSnapshot | null {
    const normalized = normalizeSessionDirectory(directory)
    const key = directoryKey(normalized)
    if (!key || !this.studyActive) return null
    const existing = this.byDirectory.get(key)
    if (existing?.active) return existing
    return this.createBucket(normalized, this.participantId)
  }

  /** One Start for the whole study; later workspace switches auto-start their own buckets. */
  start(opts: { participantId: string; directory: string }): ExperimentSnapshot {
    const participantId = opts.participantId.trim() || 'P00'
    const directory = normalizeSessionDirectory(opts.directory)
    const key = directoryKey(directory)
    if (!key) {
      throw new Error('Select a workspace folder before starting the experiment.')
    }
    this.flushFocus()
    this.studyActive = true
    this.participantId = participantId
    this.currentKey = key
    const existing = this.byDirectory.get(key)
    const snap = existing?.active ? existing : this.createBucket(directory, participantId)
    this.emit()
    return snap
  }

  /** End the current workspace only (keeps study active so other folders still record). */
  end(notes?: string, directory?: string): ExperimentReport | null {
    const key = directory !== undefined ? directoryKey(directory) : this.currentKey
    if (!key) return null
    const snap = this.byDirectory.get(key)
    if (!snap?.active) return null
    if (key === this.currentKey) this.flushFocus()
    else this.flushFocusFor(snap)
    this.flushAgentWorkFor(snap, { experimentEnd: true })
    this.trackOn(snap, 'experiment.end', undefined, { notes: notes || undefined })
    const report = snapToReport(snap, notes)
    this.byDirectory.delete(key)
    if (this.byDirectory.size === 0) this.studyActive = false
    this.emit()
    return report
  }

  /** End every active workspace recording and clear the study (manual End only). */
  endAll(notes?: string): ExperimentReport[] {
    this.flushFocus()
    const reports: ExperimentReport[] = []
    for (const [key, snap] of [...this.byDirectory.entries()]) {
      if (!snap.active) continue
      this.flushFocusFor(snap)
      this.flushAgentWorkFor(snap, { experimentEnd: true })
      this.trackOn(snap, 'experiment.end', undefined, { notes: notes || undefined })
      reports.push(snapToReport(snap, notes))
      this.byDirectory.delete(key)
    }
    this.studyActive = false
    this.emit()
    return reports
  }

  /**
   * Flush in-flight focus timers and persist drafts to localStorage.
   * Used on tab hide / unload — does NOT end the study (swipe-away / app switch must not stop recording).
   */
  checkpointDraft() {
    if (!this.studyActive && this.byDirectory.size === 0) return
    this.flushFocus()
    this.emit()
  }

  track(event: ExperimentEventName, sessionId?: string, props?: Record<string, unknown>) {
    const snap = this.getSnapshot()
    if (!snap) return
    this.trackOn(snap, event, sessionId, props)
    this.emit()
  }

  private trackOn(
    snap: ExperimentSnapshot,
    event: ExperimentEventName,
    sessionId?: string,
    props?: Record<string, unknown>,
  ) {
    if (!snap.active) return
    const entry: ExperimentEvent = {
      ts: nowIso(),
      event,
      sessionId: sessionId || undefined,
      directory: snap.directory,
      props: props && Object.keys(props).length ? props : undefined,
    }
    snap.events.push(entry)
    if (snap.events.length > MAX_EVENTS) {
      snap.events.splice(0, snap.events.length - MAX_EVENTS)
    }
  }

  private bump(key: keyof ExperimentCounters, by = 1) {
    const snap = this.getSnapshot()
    if (!snap) return
    snap.counters[key] = (snap.counters[key] || 0) + by
  }

  /** Record first click/scroll/send for a UI region (idempotent). */
  private markFirst(region: ExperimentRegion, via: string) {
    const snap = this.getSnapshot()
    if (!snap) return
    if (snap.firstInteractionAt[region]) return
    const at = nowIso()
    snap.firstInteractionAt[region] = at
    this.track('region.first', undefined, { region, via })
  }

  private noteSession(sessionId: string | undefined) {
    const snap = this.getSnapshot()
    if (!snap || !sessionId) return
    if (!snap.sessionIds.includes(sessionId)) {
      snap.sessionIds.push(sessionId)
    }
  }

  /** Manual New Session button. */
  onManualSessionCreate(sessionId: string) {
    if (!this.isActive()) return
    this.bump('manualSessionsCreated')
    this.noteSession(sessionId)
    this.track('session.create', sessionId)
  }

  /** User sent a message (counts as one conversation turn start). */
  onConversationTurn(sessionId: string) {
    if (!this.isActive()) return
    const snap = this.getSnapshot()
    this.bump('conversationTurns')
    this.noteSession(sessionId)
    this.markFirst('chat', 'chat.turn')
    if (snap && !snap.firstUserTurnAt) snap.firstUserTurnAt = nowIso()
    this.track('chat.turn', sessionId)
  }

  /** Agent started working on a user turn (composer sent / wait began). */
  onAgentTurnStart(sessionId?: string) {
    if (!this.isActive()) return
    const snap = this.getSnapshot()
    if (!snap) return
    // Nested start: close previous open interval first.
    if (snap.agentWorkStartedAt != null) this.onAgentTurnEnd(sessionId, { nested: true })
    const at = nowIso()
    if (!snap.firstUserTurnAt) snap.firstUserTurnAt = at
    snap.agentWorkStartedAt = Date.now()
    this.noteSession(sessionId)
    this.track('agent.turn_start', sessionId)
  }

  /**
   * Agent finished a turn (assistant reply observed, or user aborted).
   * Accumulates into `counters.agentWorkMs` — primary “agent working time”.
   */
  onAgentTurnEnd(sessionId?: string, props?: Record<string, unknown>) {
    if (!this.isActive()) return
    const snap = this.getSnapshot()
    if (!snap || snap.agentWorkStartedAt == null) return
    const ms = Math.max(0, Date.now() - snap.agentWorkStartedAt)
    snap.counters.agentWorkMs = (snap.counters.agentWorkMs || 0) + ms
    snap.agentWorkStartedAt = null
    const at = nowIso()
    snap.lastConversationEndAt = at
    this.noteSession(sessionId)
    this.track('agent.turn_end', sessionId, { ms, ...(props || {}) })
  }

  /** Debounced scroll burst. */
  onScroll(panel: 'chat' | 'trajectory', sessionId?: string) {
    if (!this.isActive()) return
    const key = panel
    if (this.scrollTimers[key]) return
    this.scrollTimers[key] = window.setTimeout(() => {
      this.scrollTimers[key] = null
    }, 400)
    if (panel === 'chat') {
      this.bump('chatPanelScrolls')
      this.markFirst('chat', 'chat.scroll')
      this.track('chat.scroll', sessionId)
    } else {
      this.bump('trajectoryPanelScrolls')
      this.markFirst('trajectory', 'trajectory.scroll')
      this.track('trajectory.scroll', sessionId)
    }
  }

  onTodoPanelClick(
    sessionId?: string,
    props?: { target: 'header' | 'section' | 'todo'; section?: 'open' | 'done' | 'history'; todoId?: string },
  ) {
    if (!this.isActive()) return
    this.bump('todoClicks')
    this.markFirst('todo', 'todo.panel_click')
    this.track('todo.panel_click', sessionId, props)
  }

  /** @deprecated Use onTodoPanelClick */
  onTodoClick(sessionId?: string, todoId?: string) {
    this.onTodoPanelClick(sessionId, { target: 'todo', todoId })
  }

  /** Record that the user viewed a generated subtask panel (deduped by subtask id). */
  onPanelView(subtaskId: string, sessionId?: string, via?: string) {
    const snap = this.getSnapshot()
    if (!snap || !subtaskId) return
    if (snap.seenTrajectoryIds.includes(subtaskId)) return
    snap.seenTrajectoryIds.push(subtaskId)
    snap.counters.trajectoriesViewed = snap.seenTrajectoryIds.length
    this.markFirst('trajectory', via ? `panel.view:${via}` : 'panel.view')
    this.track('panel.view', sessionId, { subtaskId, via, firstView: true })
  }

  onTrajectoryClick(sessionId?: string, props?: Record<string, unknown>) {
    if (!this.isActive()) return
    this.bump('trajectoryPanelClicks')
    this.markFirst('trajectory', 'trajectory.click')
    this.track('trajectory.click', sessionId, props)
  }

  /** User selected a subtask card (trajectory view). Prefer onPanelView via linkedSubtaskIndex effect. */
  onTrajectoryView(subtaskId: string, sessionId?: string) {
    const snap = this.getSnapshot()
    if (!snap || !subtaskId) return
    const revisit = snap.seenTrajectoryIds.includes(subtaskId)
    this.onPanelView(subtaskId, sessionId, revisit ? 'card_revisit' : 'card')
    this.onTrajectoryClick(sessionId, { subtaskId, revisit, firstView: !revisit })
  }

  onActionTooltipShow(sessionId?: string, source?: string, subtaskId?: string) {
    if (!this.isActive()) return
    this.bump('actionTooltipShows')
    // Panel view is counted on mouseenter (sweep); afterShow only bumps tooltip counters.
    if (!subtaskId) {
      this.markFirst('trajectory', source ? `tooltip.${source}` : 'tooltip.action')
    }
    this.track('tooltip.action', sessionId, { source, subtaskId })
  }

  onFlowEndSummaryTooltipShow(sessionId?: string, subtaskId?: string) {
    if (!this.isActive()) return
    this.bump('flowEndSummaryTooltipShows')
    if (!subtaskId) {
      this.markFirst('trajectory', 'tooltip.flow_end_summary')
    }
    this.track('tooltip.flow_end_summary', sessionId, subtaskId ? { subtaskId } : undefined)
  }

  onTaskTabSeen(taskTabId: string, sessionId?: string) {
    const snap = this.getSnapshot()
    if (!snap || !taskTabId) return
    if (snap.seenTaskTabIds.includes(taskTabId)) return
    snap.seenTaskTabIds.push(taskTabId)
    snap.counters.taskTabsSeen = snap.seenTaskTabIds.length
    this.track('task_tab.seen', sessionId, { taskTabId })
  }

  onTaskTabSelect(taskTabId: string, sessionId?: string) {
    if (!this.isActive()) return
    this.onTaskTabSeen(taskTabId, sessionId)
    this.bump('trajectoryPanelClicks')
    this.markFirst('task', 'task_tab.select')
    this.markFirst('trajectory', 'task_tab.select')
    this.track('task_tab.select', sessionId, { taskTabId })
  }

  /** Sidebar session list click / selection. */
  onSessionPanelInteract(_sessionId?: string) {
    if (!this.isActive()) return
    this.markFirst('session', 'session.select')
  }

  onSkillDistill(sessionId?: string, skillName?: string) {
    if (!this.isActive()) return
    this.bump('skillsDistilled')
    this.markFirst('skill', 'skill.distill')
    this.track('skill.distill', sessionId, skillName ? { skillName } : undefined)
  }

  onForkComplete(sessionId?: string, forkedSessionId?: string) {
    if (!this.isActive()) return
    this.bump('forksCompleted')
    if (forkedSessionId) this.noteSession(forkedSessionId)
    this.track('fork.complete', sessionId, forkedSessionId ? { forkedSessionId } : undefined)
  }

  onSkillPanelClick(sessionId?: string, skillKey?: string) {
    if (!this.isActive()) return
    this.bump('skillPanelClicks')
    this.markFirst('skill', 'skill.panel_click')
    this.track('skill.panel_click', sessionId, skillKey ? { skillKey } : undefined)
  }

  /** Observe generated subtask / trace panels (unique ids). */
  onSubtasksObserved(subtaskIds: string[], sessionId?: string) {
    const snap = this.getSnapshot()
    if (!snap) return
    let added = 0
    for (const id of subtaskIds) {
      if (!id || snap.seenSubtaskIds.includes(id)) continue
      snap.seenSubtaskIds.push(id)
      added += 1
    }
    if (added === 0) return
    snap.counters.subtaskPanelsGenerated = snap.seenSubtaskIds.length
    const at = nowIso()
    if (snap.firstUserTurnAt) snap.lastResultAt = at
    this.track('subtask.generated', sessionId, { added, total: snap.seenSubtaskIds.length })
  }

  enterPanelFocus(panel: ExperimentFocusPanel) {
    if (!this.isActive()) return
    this.flushFocus()
    const snap = this.getSnapshot()
    if (!snap) return
    snap.focusPanel = panel
    snap.focusStartedAt = Date.now()
  }

  /**
   * Stop timing `panel` if it is current. Optionally resume another panel
   * (used when leaving a nested region like Todo / Skill / Task tabs).
   */
  leavePanelFocus(panel: ExperimentFocusPanel, resume?: ExperimentFocusPanel) {
    if (!this.isActive()) return
    const snap = this.getSnapshot()
    if (snap?.focusPanel === panel) this.flushFocus()
    if (resume) this.enterPanelFocus(resume)
  }

  private flushAgentWorkFor(snap: ExperimentSnapshot, props?: Record<string, unknown>) {
    if (snap.agentWorkStartedAt == null) return
    const ms = Math.max(0, Date.now() - snap.agentWorkStartedAt)
    snap.counters.agentWorkMs = (snap.counters.agentWorkMs || 0) + ms
    snap.agentWorkStartedAt = null
    const at = nowIso()
    snap.lastConversationEndAt = at
    this.trackOn(snap, 'agent.turn_end', undefined, { ms, ...(props || {}) })
  }

  private flushFocus() {
    const snap = this.getSnapshot()
    if (snap) this.flushFocusFor(snap)
  }

  private flushFocusFor(snap: ExperimentSnapshot) {
    if (!snap.active || !snap.focusPanel || !snap.focusStartedAt) {
      snap.focusPanel = null
      snap.focusStartedAt = null
      return
    }
    const ms = Math.max(0, Date.now() - snap.focusStartedAt)
    const key = FOCUS_PANEL_COUNTER_KEY[snap.focusPanel]
    snap.counters[key] = ((snap.counters[key] as number) || 0) + ms
    this.trackOn(snap, 'panel.focus', undefined, { panel: snap.focusPanel, ms })
    snap.focusPanel = null
    snap.focusStartedAt = null
  }
}

export const experimentTelemetry = new ExperimentTelemetry()

export function downloadReportFallback(report: ExperimentReport) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const safePid = report.participantId.replace(/[^\w.-]+/g, '_')
  a.href = url
  a.download = `vibetrace-experiment-${safePid}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
