import { STORAGE_KEYS } from '../config/storageKeys'
import { saveExperimentReport } from '../services/memoryWorkerApi'
import { downloadReportFallback, experimentTelemetry } from './telemetry'
import type { ExperimentReport } from './types'

const PENDING_KEY = STORAGE_KEYS.experimentPendingReports
const DEBOUNCE_MS = 8000
const INTERVAL_MS = 30_000

function loadPending(): ExperimentReport[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ExperimentReport[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function savePending(reports: ExperimentReport[]) {
  try {
    if (!reports.length) {
      localStorage.removeItem(PENDING_KEY)
      return
    }
    localStorage.setItem(PENDING_KEY, JSON.stringify(reports))
  } catch {
    /* ignore quota */
  }
}

/** Stable per-experiment filename so live checkpoints overwrite instead of flooding the folder. */
export function liveReportFilename(report: ExperimentReport): string {
  const safePid = report.participantId.replace(/[^\w.-]+/g, '_') || 'participant'
  const safeExp = report.experimentId.replace(/[^\w.-]+/g, '_') || 'exp'
  return `vibetrace-experiment-${safePid}-${safeExp}.json`
}

export async function persistReport(
  report: ExperimentReport,
  opts?: { downloadOnFail?: boolean; filename?: string },
): Promise<'saved' | 'downloaded' | 'pending'> {
  const filename = opts?.filename || liveReportFilename(report)
  const downloadOnFail = opts?.downloadOnFail !== false
  try {
    await saveExperimentReport({
      directory: report.directory,
      report,
      filename,
    })
    return 'saved'
  } catch (err) {
    if (downloadOnFail) {
      downloadReportFallback(report)
      console.warn('[VibeTrace][experiment] worker write failed, downloaded instead', err)
      return 'downloaded'
    }
    savePending([...loadPending().filter((r) => r.experimentId !== report.experimentId), report])
    console.warn('[VibeTrace][experiment] worker write failed, queued pending', err)
    return 'pending'
  }
}

/** Write a live checkpoint for every active workspace folder (does not End). */
export async function persistLiveReports(opts?: { downloadOnFail?: boolean }): Promise<number> {
  const reports = experimentTelemetry.snapshotReports('live')
  if (!reports.length) return 0
  let saved = 0
  for (const report of reports) {
    const how = await persistReport(report, {
      downloadOnFail: opts?.downloadOnFail === true,
      filename: liveReportFilename(report),
    })
    if (how === 'saved') saved += 1
  }
  return saved
}

/** Retry reports that failed to flush earlier. */
export async function flushPendingExperimentReports(): Promise<number> {
  const pending = loadPending()
  if (!pending.length) return 0
  const remaining: ExperimentReport[] = []
  let saved = 0
  for (const report of pending) {
    try {
      await saveExperimentReport({
        directory: report.directory,
        report,
        filename: liveReportFilename(report),
      })
      saved += 1
    } catch {
      remaining.push(report)
    }
  }
  savePending(remaining)
  return saved
}

function resolveReportUrl(): string {
  const raw = import.meta.env.VITE_MEMORY_WORKER_BASE
  const base =
    raw === undefined || raw === ''
      ? ''
      : typeof raw === 'string'
        ? raw.trim().replace(/\/$/, '')
        : ''
  return `${base}/experiment-report`
}

/** Best-effort write during unload (sendBeacon / keepalive). Failed ones stay in pending. */
function beaconOrKeepalive(report: ExperimentReport): boolean {
  const body = JSON.stringify({
    directory: report.directory,
    report,
    filename: liveReportFilename(report),
  })
  const url = resolveReportUrl()
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      return navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
    }
  } catch {
    /* fall through */
  }
  try {
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    })
    return true
  } catch {
    return false
  }
}

let unloadInstalled = false
let debounceTimer: number | null = null
let intervalTimer: number | null = null

function flushLiveToDiskSync() {
  experimentTelemetry.checkpointDraft()
  const reports = experimentTelemetry.snapshotReports('live')
  if (!reports.length) return
  const failed: ExperimentReport[] = []
  for (const report of reports) {
    if (!beaconOrKeepalive(report)) failed.push(report)
  }
  if (failed.length) {
    const merged = new Map<string, ExperimentReport>()
    for (const r of [...loadPending(), ...failed]) merged.set(r.experimentId, r)
    savePending([...merged.values()])
  }
}

function scheduleDebouncedPersist() {
  if (typeof window === 'undefined') return
  if (debounceTimer != null) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null
    void persistLiveReports({ downloadOnFail: false })
  }, DEBOUNCE_MS)
}

/**
 * Always-on autosave:
 * - never Ends the study on hide/unload
 * - checkpoints localStorage + writes each folder's live JSON (stable overwrite)
 * - resumes buckets when the tab becomes visible again
 */
export function installExperimentAutoEndOnUnload() {
  if (typeof window === 'undefined' || unloadInstalled) return
  unloadInstalled = true

  window.addEventListener('pagehide', flushLiveToDiskSync)
  window.addEventListener('beforeunload', flushLiveToDiskSync)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushLiveToDiskSync()
      return
    }
    // Back on the page — keep recording; retry any pending disk writes.
    void flushPendingExperimentReports()
    void persistLiveReports({ downloadOnFail: false })
  })

  experimentTelemetry.subscribe(() => {
    if (experimentTelemetry.hasAnyActive()) scheduleDebouncedPersist()
  })

  if (intervalTimer == null) {
    intervalTimer = window.setInterval(() => {
      if (experimentTelemetry.hasAnyActive()) {
        void persistLiveReports({ downloadOnFail: false })
      }
    }, INTERVAL_MS)
  }
}
