import type { TurnTrace } from '../types/trace'

function resolveMemoryWorkerBase(): string {
  const raw = import.meta.env.VITE_MEMORY_WORKER_BASE
  if (typeof raw === 'string' && raw.trim()) return raw.trim().replace(/\/$/, '')
  return 'http://127.0.0.1:8714'
}

const BASE = resolveMemoryWorkerBase()

export interface MemoryWorkerIngestResult {
  ok: boolean
  runId?: string
  runDir?: string
  error?: string
  [key: string]: unknown
}

export interface IngestContext {
  directory?: string
  parentSessionID?: string
}

export async function ingestTraceToMemoryWorker(
  trace: TurnTrace,
  context?: IngestContext,
): Promise<MemoryWorkerIngestResult> {
  const res = await fetch(`${BASE}/ingest-trace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trace,
      directory: context?.directory,
      parentSessionID: context?.parentSessionID,
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`memory-worker /ingest-trace failed: ${res.status} ${text}`)
  }
  try {
    return JSON.parse(text) as MemoryWorkerIngestResult
  } catch {
    throw new Error('memory-worker /ingest-trace returned non-JSON')
  }
}

