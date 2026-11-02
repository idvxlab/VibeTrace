/** Default number of session turns included in memory-worker ingest (newest first). */
export const DEFAULT_TRACE_SESSION_TURN_LIMIT = 5

export function traceSessionTurnLimit(): number {
  const raw = import.meta.env.VITE_TRACE_SESSION_TURN_LIMIT
  if (raw === undefined || raw === '') return DEFAULT_TRACE_SESSION_TURN_LIMIT
  const n = Number.parseInt(String(raw).trim(), 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TRACE_SESSION_TURN_LIMIT
  return Math.min(n, 50)
}
