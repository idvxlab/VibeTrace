/** Cross-tab lock: one ingest per assistant stop message (localStorage). */
const TRACE_INGEST_CLAIM_PREFIX = 'vibetrace:trace-ingest-claim:'

function claimStorageKey(sessionId: string, endAssistantMessageId: string): string {
  return `${TRACE_INGEST_CLAIM_PREFIX}${sessionId}:${endAssistantMessageId}`
}

export function hasTraceIngestClaim(sessionId: string, endAssistantMessageId: string): boolean {
  const claimKey = claimStorageKey(sessionId, endAssistantMessageId)
  try {
    const raw = localStorage.getItem(claimKey)
    if (!raw) return false
    if (raw === 'baseline') {
      localStorage.removeItem(claimKey)
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Claim this stop for ingest. Returns false if already claimed (processed or in flight).
 */
export function tryClaimTraceIngest(sessionId: string, endAssistantMessageId: string): boolean {
  const claimKey = claimStorageKey(sessionId, endAssistantMessageId)
  try {
    if (localStorage.getItem(claimKey)) return false
    localStorage.setItem(claimKey, String(Date.now()))
  } catch {
    return true
  }
  return true
}

/** Release lock after a failed ingest so the same fresh stop can retry. */
export function releaseTraceIngestClaim(sessionId: string, endAssistantMessageId: string): void {
  try {
    localStorage.removeItem(claimStorageKey(sessionId, endAssistantMessageId))
  } catch {
    /* ignore */
  }
}
