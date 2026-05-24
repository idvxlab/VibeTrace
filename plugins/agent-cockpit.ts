/**
 * VibeTrace — OpenCode plugin
 *
 * OpenCode 启动 → server({ serverUrl })
 *   → 写 .env.local（Vite 代理 + 保留已有密码）
 *   → 启动 memory-worker (:8714)
 *   → 启动 Vite (:5173)
 *   → 自动打开浏览器
 *
 * 跨平台：Windows / macOS / Linux 自动识别（npm、python、open 浏览器命令）
 */

import { exec, spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 项目根：plugins/ → 上一级；.opencode/plugins/ → 上两级 */
function resolveProjectRoot(pluginDir: string): string {
  const parent = path.resolve(pluginDir, "..")
  if (existsSync(path.join(parent, "package.json"))) return parent
  const grandparent = path.resolve(pluginDir, "..", "..")
  if (existsSync(path.join(grandparent, "package.json"))) return grandparent
  return parent
}

const PROJECT_ROOT = resolveProjectRoot(__dirname)
const VITE_PORT = 5173
const MEMORY_WORKER_PORT = 8714
const isWin = process.platform === "win32"
const isMac = process.platform === "darwin"

let devStarted = false
let memoryWorkerProc: ChildProcess | null = null
let viteProc: ChildProcess | null = null

function resolveNpm(): string {
  return isWin ? "npm.cmd" : "npm"
}

/** macOS/Linux 优先 python3；Windows 用 python；可用 PYTHON 环境变量覆盖 */
function resolvePython(): string {
  if (process.env.PYTHON?.trim()) return process.env.PYTHON.trim()
  return isWin ? "python" : "python3"
}

function openBrowser(url: string): void {
  if (process.env.VIBETRACE_NO_BROWSER === "1") {
    console.log(`[VibeTrace] skip browser (VIBETRACE_NO_BROWSER=1) → ${url}`)
    return
  }
  console.log(`[VibeTrace] opening → ${url}`)
  if (isWin) {
    exec(`start "" "${url}"`)
  } else if (isMac) {
    exec(`open "${url}"`)
  } else {
    exec(`xdg-open "${url}"`)
  }
}

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of content.split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const i = t.indexOf("=")
    if (i <= 0) continue
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

function formatEnvFile(mode: 'manual' | 'plugin', vars: Record<string, string>): string {
  const lines = [
    mode === 'plugin'
      ? '# 由 OpenCode plugin 自动写入（桌面端打开项目时）；手动开发请 cp .env.example .env.local'
      : '# 手动开发配置（opencode serve 默认 4096）；桌面端打开后 plugin 会覆盖端口/密码',
    "",
  ]
  for (const [k, v] of Object.entries(vars)) {
    lines.push(`${k}=${v}`)
  }
  lines.push("")
  return lines.join("\n")
}

/** 桌面端每次启动可能换新密码/端口；以 process.env 为准，覆盖 .env.local 里的旧值 */
function syncOpencodeAuthFromProcess(merged: Record<string, string>): void {
  const pwd = process.env.OPENCODE_SERVER_PASSWORD?.trim()
  if (pwd) {
    merged.VITE_OPENCODE_SERVER_PASSWORD = pwd
    merged.OPENCODE_SERVER_PASSWORD = pwd
  }
  const user = process.env.OPENCODE_SERVER_USERNAME?.trim()
  if (user) {
    merged.VITE_OPENCODE_SERVER_USERNAME = user
    merged.OPENCODE_SERVER_USERNAME = user
  }
}

function killListenerOnPort(port: number): Promise<void> {
  return new Promise((resolve) => {
    if (isWin) {
      exec(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        () => resolve(),
      )
      return
    }
    exec(`lsof -ti:${port} 2>/dev/null | xargs kill -9 2>/dev/null`, () => resolve())
  })
}

function writeEnvLocal(serverUrl: URL): Record<string, string> {
  const envPath = path.join(PROJECT_ROOT, ".env.local")
  const port = serverUrl.port || (serverUrl.protocol === "https:" ? "443" : "80")
  const proxyTarget = `${serverUrl.protocol}//${serverUrl.hostname}:${port}`

  let existing: Record<string, string> = {}
  if (existsSync(envPath)) {
    try {
      existing = parseEnvFile(readFileSync(envPath, "utf-8"))
    } catch { /* ignore */ }
  }

  const merged: Record<string, string> = {
    ...existing,
    VITE_OPENCODE_BASE: "",
    OPENCODE_PROXY_TARGET: proxyTarget,
    VITE_MEMORY_WORKER_BASE: existing.VITE_MEMORY_WORKER_BASE ?? "",
    MEMORY_WORKER_PROXY_TARGET:
      existing.MEMORY_WORKER_PROXY_TARGET ?? `http://127.0.0.1:${MEMORY_WORKER_PORT}`,
    OPENCODE_BASE: proxyTarget,
  }

  if (serverUrl.username) {
    const user = decodeURIComponent(serverUrl.username)
    merged.VITE_OPENCODE_SERVER_USERNAME = user
    merged.OPENCODE_SERVER_USERNAME = user
  }
  if (serverUrl.password) {
    const pwd = decodeURIComponent(serverUrl.password)
    merged.VITE_OPENCODE_SERVER_PASSWORD = pwd
    merged.OPENCODE_SERVER_PASSWORD = pwd
  }
  syncOpencodeAuthFromProcess(merged)
  merged.VIBETRACE_OPENCODE_MODE = "plugin"

  try {
    writeFileSync(envPath, formatEnvFile("plugin", merged), "utf-8")
    console.log(`[VibeTrace] .env.local updated → proxy ${proxyTarget}`)
  } catch (err) {
    console.error("[VibeTrace] cannot write .env.local:", err)
  }
  return merged
}

async function ensureMemoryWorker(spawnEnv: Record<string, string> = {}): Promise<void> {
  const healthUrl = `http://127.0.0.1:${MEMORY_WORKER_PORT}/health`
  try {
    const r = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) })
    if (r.ok) {
      console.log(`[VibeTrace] memory-worker 重启以加载最新 .env.local → :${MEMORY_WORKER_PORT}`)
      await killListenerOnPort(MEMORY_WORKER_PORT)
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
  } catch { /* not running */ }

  const script = path.join(PROJECT_ROOT, "memory_worker", "server.py")
  if (!existsSync(script)) {
    console.warn("[VibeTrace] memory_worker/server.py not found, skip")
    return
  }

  const py = resolvePython()
  console.log(`[VibeTrace] starting memory-worker (${py}) → :${MEMORY_WORKER_PORT}`)
  memoryWorkerProc = spawn(py, [script], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: "ignore",
    shell: isWin,
    env: { ...process.env, ...spawnEnv },
  })
  memoryWorkerProc.unref()

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500))
    try {
      const r = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) })
      if (r.ok) {
        console.log(`[VibeTrace] memory-worker ready`)
        return
      }
    } catch { /* retry */ }
  }
  console.warn(`[VibeTrace] memory-worker 未就绪。手动: npm run worker:py`)
}

async function waitForPort(port: number, ms = 40_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
      if (r.ok || r.status < 500) return true
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 600))
  }
  return false
}

async function startDevServer(serverUrl: URL): Promise<void> {
  if (devStarted) return
  devStarted = true

  if (!existsSync(path.join(PROJECT_ROOT, "node_modules"))) {
    console.error(`[VibeTrace] 请先安装依赖: cd "${PROJECT_ROOT}" && npm install`)
    return
  }

  const envPath = path.join(PROJECT_ROOT, ".env.local")
  const envVars = writeEnvLocal(serverUrl)
  await ensureMemoryWorker(envVars)

  const uiUrl = `http://127.0.0.1:${VITE_PORT}/`
  const viteEnv = { ...process.env, ...envVars }
  const proxyTarget = (envVars.OPENCODE_PROXY_TARGET ?? envVars.OPENCODE_BASE ?? "").trim()

  let viteRunning = false
  try {
    const r = await fetch(uiUrl, { signal: AbortSignal.timeout(800) })
    viteRunning = r.ok || r.status < 500
  } catch { /* not running */ }

  // 桌面端每次端口/密码可能变化；旧 Vite 只在启动时读 .env → 必须重启，否则 401 弹登录框
  if (viteRunning) {
    console.log(
      `[VibeTrace] 重启 Vite 以应用 .env.local（OpenCode → ${proxyTarget || "—"}）→ :${VITE_PORT}`,
    )
    await killListenerOnPort(VITE_PORT)
    await new Promise((r) => setTimeout(r, 1000))
    viteRunning = false
  }

  console.log(`[VibeTrace] starting Vite (${resolveNpm()} run dev) …`)
  viteProc = spawn(resolveNpm(), ["run", "dev"], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: "ignore",
    shell: isWin,
    env: viteEnv,
  })
  viteProc.unref()

  const ready = await waitForPort(VITE_PORT, 40_000)
  if (ready) {
    console.log(`[VibeTrace] ready → ${uiUrl}`)
    openBrowser(uiUrl)
  } else {
    console.error(`[VibeTrace] Vite 未就绪。手动: cd "${PROJECT_ROOT}" && npm run dev`)
  }
}

const server = async ({ serverUrl }: { serverUrl: URL }) => {
  console.log(`[VibeTrace] OpenCode API → ${serverUrl}`)
  console.log(`[VibeTrace] platform → ${process.platform}, project → ${PROJECT_ROOT}`)
  void startDevServer(serverUrl)
  return {}
}

export default { id: "vibetrace-ui", server }
