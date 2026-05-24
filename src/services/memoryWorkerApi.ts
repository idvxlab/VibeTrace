import type { IngestTracePayload } from '../types/trace'

function resolveMemoryWorkerBase(): string {
  const raw = import.meta.env.VITE_MEMORY_WORKER_BASE
  // 空字符串或未配置 = 同源 /ingest-trace，由 Vite 代理到 memory-worker（plugin 模式）
  if (raw === undefined || raw === '') return ''
  if (typeof raw === 'string') return raw.trim().replace(/\/$/, '')
  return ''
}

const BASE = resolveMemoryWorkerBase()

export interface MemoryWorkerIngestResult {
  ok: boolean
  runId?: string
  runDir?: string
  error?: string
  /** Worker returned an existing run instead of starting a second pipeline. */
  duplicate?: boolean
  dedupKey?: string
  [key: string]: unknown
}

export interface IngestContext {
  directory?: string
  parentSessionID?: string
}

export async function ingestTraceToMemoryWorker(
  trace: IngestTracePayload,
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

