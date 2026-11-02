/** Poll OpenCode session list after memory_worker creates background pipeline sessions. */
const POLL_MS = 12_000
const POLL_WINDOW_MS = 3 * 60_000

let pollTimer: ReturnType<typeof setInterval> | null = null
let pollUntilMs = 0

export function scheduleMwInternalSessionRefresh(refreshSessions: () => Promise<unknown>): void {
  void refreshSessions()
  pollUntilMs = Math.max(pollUntilMs, Date.now() + POLL_WINDOW_MS)
  if (pollTimer !== null) return
  pollTimer = setInterval(() => {
    if (Date.now() > pollUntilMs) {
      if (pollTimer !== null) clearInterval(pollTimer)
      pollTimer = null
      return
    }
    void refreshSessions()
  }, POLL_MS)
}
