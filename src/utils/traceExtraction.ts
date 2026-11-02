import type { OcMessage } from '../types/opencode'

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function nestedMessageRecord(message: OcMessage): Record<string, unknown> | null {
  return asRecord(asRecord(message)?.message)
}

function getMessageFinish(message: OcMessage): string | undefined {
  const direct = asRecord(message)
  const nested = nestedMessageRecord(message)
  const candidates = [
    message.info.finish,
    typeof nested?.finish === 'string' ? nested.finish : undefined,
    typeof direct?.finish === 'string' ? direct.finish : undefined,
  ]
  return candidates.find((x): x is string => Boolean(x))
}

function isStopFinish(message: OcMessage): boolean {
  return getMessageFinish(message)?.trim().toLowerCase() === 'stop'
}

function isAssistantTerminalMessage(message: OcMessage): boolean {
  if (message.info.role !== 'assistant') return false
  return isStopFinish(message)
}

export function findLatestAssistantStopMessage(messages: OcMessage[]): OcMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg && isAssistantTerminalMessage(msg)) return msg
  }
  return null
}

export function findRecentAssistantStopMessages(messages: OcMessage[], limit: number = 5): OcMessage[] {
  const out: OcMessage[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || !isAssistantTerminalMessage(msg)) continue
    out.push(msg)
    if (out.length >= limit) break
  }
  return out.reverse()
}

/** Auto-ingest only if the assistant turn finished within this window (2 minutes). */
export const TRACE_INGEST_FRESH_WINDOW_MS = 2 * 60_000

/** Normalize OpenCode timestamps (seconds or ms) to epoch ms. */
function normalizeEpochMs(value: number): number {
  if (!Number.isFinite(value)) return value
  if (value < 1e11) return value * 1000
  if (value > 1e14) return Math.floor(value / 1000)
  return value
}

function readCompletedMs(message: OcMessage): number | null {
  const completed = message.info.time?.completed
  if (typeof completed === 'number' && Number.isFinite(completed)) {
    return normalizeEpochMs(completed)
  }
  const nested = nestedMessageRecord(message)
  const nestedTime = nested ? asRecord(nested.time) : null
  const nestedCompleted = nestedTime?.completed
  if (typeof nestedCompleted === 'number' && Number.isFinite(nestedCompleted)) {
    return normalizeEpochMs(nestedCompleted)
  }
  return null
}

/**
 * Whether this stop is recent enough to auto-ingest.
 * A completed assistant turn is only a real turn boundary when `finish: "stop"` is present.
 * Uses completion time only after that stop is visible; if `completed` is not set yet (SSE lag), treat as fresh.
 */
export function isAssistantStopWithinIngestWindow(
  message: OcMessage,
  nowMs: number = Date.now(),
  windowMs: number = TRACE_INGEST_FRESH_WINDOW_MS,
): boolean {
  const completedMs = readCompletedMs(message)
  if (completedMs != null) {
    return nowMs - completedMs <= windowMs
  }
  return true
}

/** For debug logs: when the stop finished (ms), if known. */
export function getAssistantStopCompletedMs(message: OcMessage): number | null {
  return readCompletedMs(message)
}
