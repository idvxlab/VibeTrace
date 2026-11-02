/// <reference types="vite/client" />

/** Injected by `vite.config.ts` `define` */
declare const __OPENCODE_HTTP_BASE__: string

interface ImportMetaEnv {
  /** Override OpenCode HTTP base, e.g. http://127.0.0.1:61830 */
  readonly VITE_OPENCODE_BASE?: string
  /** Mirrors `OPENCODE_SERVER_PASSWORD` from `opencode serve` for HTTP Basic auth */
  readonly VITE_OPENCODE_SERVER_PASSWORD?: string
  /** Optional; defaults to `opencode` (maps to `OPENCODE_SERVER_USERNAME`) */
  readonly VITE_OPENCODE_SERVER_USERNAME?: string
  /** `provider/model` shorthand; outbound requests expand to `{ providerID, modelID }` objects */
  readonly VITE_OPENCODE_DEFAULT_MODEL?: string
  /** Optional `agent` string appended alongside the payload when the server expects it */
  readonly VITE_OPENCODE_DEFAULT_AGENT?: string
  /** Local memory-worker backend base, e.g. http://127.0.0.1:8714 */
  readonly VITE_MEMORY_WORKER_BASE?: string
  /** Enable noisy debug console logs when set to true */
  readonly VITE_DEBUG_VERBOSE_LOGS?: string
  /** Max session turns in memory-worker ingest bundle (newest first); default 5 */
  readonly VITE_TRACE_SESSION_TURN_LIMIT?: string
}
