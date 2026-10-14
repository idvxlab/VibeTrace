/** Experiment telemetry schemas (local user-study metrics). */

/** UI regions whose first user touch (click / scroll / send) we record. */
export type ExperimentRegion = 'chat' | 'trajectory' | 'todo' | 'skill' | 'session' | 'task'

/** Panels that accumulate pointer-hover focus time. */
export type ExperimentFocusPanel =
  | 'chat'
  | 'todo'
  | 'session'
  | 'task'
  | 'trajectory'
  | 'skill'
  | 'tooltip'

/** ISO timestamp of first interaction per region; null if never touched. */
export type FirstInteractionAt = Record<ExperimentRegion, string | null>

export type ExperimentCounters = {
  /** Manual “New session” clicks (excludes mw-internal). */
  manualSessionsCreated: number
  /** User→assistant conversation turns completed (user sends count as proxy). */
  conversationTurns: number
  /** Debounced scroll bursts in the middle chat panel. */
  chatPanelScrolls: number
  /** Debounced scroll bursts in the right trajectory panel. */
  trajectoryPanelScrolls: number
  /** Clicks / selections inside the right trajectory panel (excl. tooltip). */
  trajectoryPanelClicks: number
  /** Clicks anywhere inside the Todo panel (header, sections, todo rows). */
  todoClicks: number
  /** Action-node tooltips that actually opened (timeline + summary blocks). */
  actionTooltipShows: number
  /** Flow-end yellow “summary” node tooltips that opened. */
  flowEndSummaryTooltipShows: number
  /** Unique subtask / trace panels the user viewed (select, scroll into view, tooltip, etc.). */
  trajectoriesViewed: number
  /** Unique task tabs that existed or were selected during the experiment. */
  taskTabsSeen: number
  /** Successful skill distill operations. */
  skillsDistilled: number
  /** Confirmed forks from an action. */
  forksCompleted: number
  /** Clicks that open a skill detail from the Skill Panel. */
  skillPanelClicks: number
  /** Unique subtask / trace panels generated (observed) during the experiment. */
  subtaskPanelsGenerated: number
  /** Cumulative ms pointer was over the middle chat/composer column (excl. Todo). */
  chatPanelFocusMs: number
  /** Cumulative ms pointer was over the Todo panel. */
  todoPanelFocusMs: number
  /** Cumulative ms pointer was over the left session list. */
  sessionPanelFocusMs: number
  /** Cumulative ms pointer was over the right Task tab bar. */
  taskBarFocusMs: number
  /** Cumulative ms pointer was over the right trajectory body (incl. action-type legend). */
  trajectoryPanelFocusMs: number
  /** Cumulative ms pointer was over the Skill Panel dock / detail. */
  skillPanelFocusMs: number
  /** Cumulative ms while an action / flow-end tooltip was open. */
  tooltipPanelFocusMs: number
  /**
   * Cumulative ms the agent was working on a user turn
   * (from send / wait-start → assistant reply finished or abort).
   */
  agentWorkMs: number
}

export type ExperimentEventName =
  | 'experiment.start'
  | 'experiment.end'
  | 'session.create'
  | 'chat.turn'
  | 'chat.scroll'
  | 'trajectory.scroll'
  | 'trajectory.click'
  | 'todo.click'
  | 'todo.panel_click'
  | 'tooltip.action'
  | 'tooltip.flow_end_summary'
  | 'trajectory.view'
  | 'panel.view'
  | 'task_tab.seen'
  | 'task_tab.select'
  | 'skill.distill'
  | 'fork.complete'
  | 'skill.panel_click'
  | 'subtask.generated'
  | 'panel.focus'
  | 'region.first'
  | 'agent.turn_start'
  | 'agent.turn_end'

export type ExperimentEvent = {
  ts: string
  event: ExperimentEventName
  sessionId?: string
  directory?: string
  props?: Record<string, unknown>
}

export type PanelFocusShares = Record<ExperimentFocusPanel, number | null>

/** Focus ms broken down by solve-window third (early / mid / late). */
export type SolvePhaseFocusMs = Record<'early' | 'mid' | 'late', Record<ExperimentFocusPanel, number>>

/** Panels that count as VibeTrace / structured-trace UI (vs plain chat). */
export const VIBETRACE_FOCUS_PANELS: ExperimentFocusPanel[] = [
  'trajectory',
  'todo',
  'task',
  'skill',
  'tooltip',
]

export type ExperimentReport = {
  schemaVersion: 'experiment.report.v1'
  participantId: string
  experimentId: string
  directory: string
  startedAt: string
  endedAt: string
  durationMs: number
  /** Session ids touched during the experiment (manual + forked; never mw-internal). */
  sessionIds: string[]
  counters: ExperimentCounters
  /**
   * First click/scroll/send timestamp per UI region (ISO), or null if unused.
   * Sort these (or use derived.firstInteractionOrder) to recover discovery order.
   */
  firstInteractionAt: FirstInteractionAt
  /** Derived ratios for convenience. */
  derived: {
    chatFocusRatio: number | null
    todoFocusRatio: number | null
    sessionFocusRatio: number | null
    taskBarFocusRatio: number | null
    trajectoryFocusRatio: number | null
    skillFocusRatio: number | null
    tooltipFocusRatio: number | null
    /** Per-panel share of all focus ms (sums to 1 when any focus was recorded). */
    panelFocusShares: PanelFocusShares
    chatScrollShare: number | null
    trajectoryInteractionShare: number | null
    /** Regions ordered by firstInteractionAt (earliest first); untouched omitted. */
    firstInteractionOrder: ExperimentRegion[]
    /** ms from experiment start to first touch; null if never touched. */
    firstInteractionMs: Record<ExperimentRegion, number | null>
    /** Unique panels viewed / unique panels generated (null when none generated). */
    panelViewCoverage: number | null

    // --- Timeline / conversation metrics (additive; legacy fields unchanged) ---
    /** Sum of all panel focus counters (proxy for time spent on the UI). */
    systemFocusMs: number
    /** Share of wall-clock duration covered by systemFocusMs. */
    systemFocusWallShare: number | null
    /** ISO of first user message send (`chat.turn` / agent.turn_start). */
    firstUserTurnAt: string | null
    /** ms from experiment start to firstUserTurnAt. */
    firstUserTurnMs: number | null
    /** ISO when the last agent turn finished (`agent.turn_end`). */
    lastConversationEndAt: string | null
    /** ms from firstUserTurnAt → lastConversationEndAt (includes user think time between turns). */
    conversationSpanMs: number | null
    /**
     * Cumulative agent busy time (`counters.agentWorkMs`) —
     * sum of (send → assistant done) over turns. Primary effort metric.
     */
    agentWorkMs: number
    /** agentWorkMs / conversationSpanMs when both available. */
    agentWorkShareOfConversation: number | null
    /**
     * ISO of last `subtask.generated` at/after first user turn
     * (secondary: trajectory materialization, not conversation end).
     */
    solveEndAt: string | null
    /** ms from firstUserTurnAt to solveEndAt. */
    solveDurationMs: number | null
    /** Wall ms from first interactive event to last (uncapped). */
    activeSpanMs: number | null
    /**
     * Engaged wall-time estimate: sum of gaps between interactive events,
     * each gap capped at 5 minutes (reduces idle inflation).
     */
    idleCappedActiveMs: number | null
    /**
     * Sum of `panel.focus` ms inside the conversation window
     * (firstUserTurnAt → lastConversationEndAt, fallback solveEndAt).
     */
    focusDuringSolveMs: number | null
    /** Panel shares of focusDuringSolveMs. */
    focusDuringSolveShares: PanelFocusShares | null
    /**
     * (trajectory+todo+task+skill+tooltip) / focusDuringSolveMs —
     * how much of conversation-window attention was on VibeTrace UI.
     */
    vibetraceFocusShareDuringSolve: number | null
    /** Focus ms by panel in each third of the conversation window. */
    solvePhaseFocusMs: SolvePhaseFocusMs | null
    /** VibeTrace focus share within each conversation-window third. */
    solvePhaseVibetraceShare: Record<'early' | 'mid' | 'late', number | null> | null
  }
  /** Recent event log (capped). */
  events: ExperimentEvent[]
  notes?: string
}

export type ExperimentSnapshot = {
  active: boolean
  participantId: string
  experimentId: string
  directory: string
  startedAt: string
  sessionIds: string[]
  seenTrajectoryIds: string[]
  seenTaskTabIds: string[]
  seenSubtaskIds: string[]
  counters: ExperimentCounters
  firstInteractionAt: FirstInteractionAt
  events: ExperimentEvent[]
  /** Wall-clock when focus entered a panel (ms). */
  focusStartedAt: number | null
  focusPanel: ExperimentFocusPanel | null
  /** First `chat.turn` ISO. */
  firstUserTurnAt: string | null
  /** Last `subtask.generated` ISO at/after first user turn. */
  lastResultAt: string | null
  /** Last finished agent turn ISO (`agent.turn_end`). */
  lastConversationEndAt: string | null
  /** Wall-clock ms when current agent turn started; null if idle. */
  agentWorkStartedAt: number | null
}

export const EXPERIMENT_REGIONS: ExperimentRegion[] = [
  'chat',
  'trajectory',
  'todo',
  'skill',
  'session',
  'task',
]

export const EXPERIMENT_FOCUS_PANELS: ExperimentFocusPanel[] = [
  'chat',
  'todo',
  'session',
  'task',
  'trajectory',
  'skill',
  'tooltip',
]

export const FOCUS_PANEL_COUNTER_KEY: Record<
  ExperimentFocusPanel,
  keyof ExperimentCounters
> = {
  chat: 'chatPanelFocusMs',
  todo: 'todoPanelFocusMs',
  session: 'sessionPanelFocusMs',
  task: 'taskBarFocusMs',
  trajectory: 'trajectoryPanelFocusMs',
  skill: 'skillPanelFocusMs',
  tooltip: 'tooltipPanelFocusMs',
}

export function emptyFirstInteractionAt(): FirstInteractionAt {
  return {
    chat: null,
    trajectory: null,
    todo: null,
    skill: null,
    session: null,
    task: null,
  }
}

export function emptyCounters(): ExperimentCounters {
  return {
    manualSessionsCreated: 0,
    conversationTurns: 0,
    chatPanelScrolls: 0,
    trajectoryPanelScrolls: 0,
    trajectoryPanelClicks: 0,
    todoClicks: 0,
    actionTooltipShows: 0,
    flowEndSummaryTooltipShows: 0,
    trajectoriesViewed: 0,
    taskTabsSeen: 0,
    skillsDistilled: 0,
    forksCompleted: 0,
    skillPanelClicks: 0,
    subtaskPanelsGenerated: 0,
    chatPanelFocusMs: 0,
    todoPanelFocusMs: 0,
    sessionPanelFocusMs: 0,
    taskBarFocusMs: 0,
    trajectoryPanelFocusMs: 0,
    skillPanelFocusMs: 0,
    tooltipPanelFocusMs: 0,
    agentWorkMs: 0,
  }
}

export function totalFocusMs(c: ExperimentCounters): number {
  return (
    c.chatPanelFocusMs +
    c.todoPanelFocusMs +
    c.sessionPanelFocusMs +
    c.taskBarFocusMs +
    c.trajectoryPanelFocusMs +
    c.skillPanelFocusMs +
    c.tooltipPanelFocusMs
  )
}
