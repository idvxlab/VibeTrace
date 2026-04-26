/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 覆盖 OpenCode HTTP 基址，例如 http://127.0.0.1:61830 */
  readonly VITE_OPENCODE_BASE?: string
  /** 与 `opencode serve` 的 `OPENCODE_SERVER_PASSWORD` 一致，用于 HTTP Basic 认证 */
  readonly VITE_OPENCODE_SERVER_PASSWORD?: string
  /** 可选，默认 `opencode`，对应 `OPENCODE_SERVER_USERNAME` */
  readonly VITE_OPENCODE_SERVER_USERNAME?: string
  /** `provider/model` 字符串；发送时会转为 `{ providerID, modelID }`（API 不接受字符串） */
  readonly VITE_OPENCODE_DEFAULT_MODEL?: string
  /** 发往同上接口时附带 `agent` 字段（若服务端需要） */
  readonly VITE_OPENCODE_DEFAULT_AGENT?: string
}
