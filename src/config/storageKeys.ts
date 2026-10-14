/**
 * Browser-only “Bookmarks” for this app — not sent to servers, not in git.
 *
 * When you reload the tab, React starts empty. Chrome/Edge uses `localStorage` (survives tab close) and
 * `sessionStorage` (cleared when the tab closes) to remember things like “which dirs you added”, “composer model”,
 * “fork-panel draft per session”.
 *
 * `APP_STORAGE_NAMESPACE` is the **prefix** on those bookmark names so our keys never clash with OpenCode keys or
 * other sites. Changing it only matters like **renaming a folder**: old names are ignored, stored UI state resets
 * (re-add dirs, etc.) — nothing breaks server-side / OpenCode.
 *
 * Flip this single string whenever you intentionally want fresh client cache (solo dev vs. OSS users: each browser
 * is independent; nobody else loses data when you change your local build).
 */
export const APP_STORAGE_NAMESPACE = 'vibetrace'

export const STORAGE_KEYS = {
  manualDirectories: `${APP_STORAGE_NAMESPACE}.manual.directories.v1`,
  /** Workspace paths ever seen in session list — used to re-fetch full history on refresh */
  knownDirectories: `${APP_STORAGE_NAMESPACE}.known.directories.v1`,
  closedDirectories: `${APP_STORAGE_NAMESPACE}.closed.directories.v1`,
  composerModelRef: `${APP_STORAGE_NAMESPACE}.opencodeComposerModelRef`,
  sidebarSessionListWidth: `${APP_STORAGE_NAMESPACE}.layout.sidebarSessionListWidth.v1`,
  subtaskPanelWidth: `${APP_STORAGE_NAMESPACE}.layout.subtaskPanelWidth.v1`,
  taskSegments: `${APP_STORAGE_NAMESPACE}.taskSegments.v1`,
  activeTaskSegments: `${APP_STORAGE_NAMESPACE}.activeTaskSegments.v1`,
  taskSegmentManualSelection: `${APP_STORAGE_NAMESPACE}.taskSegmentManualSelection.v1`,
  /** Per-session subtask panel analysis (trace summary / error diagnosis) keyed by subtaskId */
  panelAnalysis: `${APP_STORAGE_NAMESPACE}.panelAnalysis.v1`,
  /** Prefix for `${prefix}${sessionId}` fork-panel snapshot entries */
  forkPanelPrefix: `${APP_STORAGE_NAMESPACE}:fork-panel:`,
  /**
   * Active user-study experiment drafts, keyed by workspace directory
   * (survives refresh until End / tab close). Schema v2 in telemetry.ts.
   */
  experimentActive: `${APP_STORAGE_NAMESPACE}.experiment.active.v1`,
  /** Reports that failed to flush on tab close — retried on next load. */
  experimentPendingReports: `${APP_STORAGE_NAMESPACE}.experiment.pendingReports.v1`,
} as const

/** Composer `<select>` DOM id — must match `<label htmlFor>`; unrelated to persistence key spelling */
export const COMPOSER_MODEL_DOM_ID = `${APP_STORAGE_NAMESPACE}-composer-model`

/** Bottom inset for composer / skill dock — keep MessageInput and VibeTrace panel in sync. */
export const MAIN_COLUMN_BOTTOM_INSET_PX = 10
