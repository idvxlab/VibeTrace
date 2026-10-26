import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, openSync, closeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function defaultRuntimeDir() {
  if (process.platform === 'win32') return resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData/Local'), 'VibeTrace')
  if (process.platform === 'darwin') return resolve(homedir(), 'Library/Application Support/VibeTrace')
  return resolve(process.env.XDG_STATE_HOME || resolve(homedir(), '.local/state'), 'vibetrace')
}
export const runtimeDir = process.env.VIBETRACE_RUNTIME_DIR || defaultRuntimeDir()
export function pythonExecutable(configured) {
  const python = configured || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  return execFileSync(python, ['-c', 'import sys; assert sys.version_info >= (3, 9), "Python 3.9+ required"; print(sys.executable)'], { encoding: 'utf8' }).trim()
}
export function nodeExecutable(configured, host = process) {
  // Electron utility processes expose their helper executable as execPath.
  // Only a plain Node host can safely reuse its own executable.
  const node = configured || process.env.VIBETRACE_NODE ||
    (host.versions.bun || host.versions.electron ? 'node' : host.execPath)
  let result
  try {
    result = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify({path:process.execPath,node:process.versions.node,electron:!!process.versions.electron,bun:!!process.versions.bun})'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim())
  } catch {
    throw new Error('VibeTrace could not start Node.js. Install Node.js 20+ or set VIBETRACE_NODE to its absolute executable path; then restart OpenCode.')
  }
  if (typeof result.path !== 'string' || !result.path.trim() || result.electron || result.bun || !(Number(result.node?.split('.')[0]) >= 20)) {
    throw new Error('VibeTrace requires a standalone Node.js 20+ executable. Set VIBETRACE_NODE to its absolute path; then restart OpenCode.')
  }
  return result.path
}
export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawn(cmd, args, { stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}
export async function liveState(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    const response = await fetch(`${state.url}/__vibetrace/status`, { signal: AbortSignal.timeout(1000) })
    const actual = await response.json()
    if (actual.service === 'vibetrace-plugin' && actual.root === root && actual.parentPid === state.parentPid && actual.serverUrl === state.serverUrl) return state
  } catch {}
  return null
}
const pending = new Map()
export function ensureRuntime(ctx, options = {}) {
  const url = new URL(ctx.serverUrl)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return Promise.reject(new Error('VibeTrace first version supports local HTTP OpenCode servers'))
  const password = ctx.vibetraceAuth?.password || process.env.OPENCODE_SERVER_PASSWORD || decodeURIComponent(url.password)
  const username = ctx.vibetraceAuth?.username || process.env.OPENCODE_SERVER_USERNAME || decodeURIComponent(url.username) || 'opencode'
  url.username = ''; url.password = ''
  const key = createHash('sha256').update(`${process.pid}:${url.href}:${username}:${password}`).digest('hex').slice(0, 16)
  if (pending.has(key)) {
    const current = pending.get(key)
    return current.then(async () => {
      const live = await liveState(resolve(runtimeDir, `${key}.json`))
      if (live) return live
      if (pending.get(key) === current) pending.delete(key)
      return ensureRuntime(ctx, options)
    })
  }
  const promise = start(ctx, url.href, username, password, key, options).catch(e => { pending.delete(key); throw e })
  pending.set(key, promise)
  return promise
}
async function start(ctx, serverUrl, username, password, key, options) {
  const python = pythonExecutable(options.python)
  const node = nodeExecutable(options.node)
  if (!existsSync(resolve(root, 'dist/.vibetrace-plugin-build'))) throw new Error('Run npm run build:plugin before installing VibeTrace')
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const stateFile = resolve(runtimeDir, `${key}.json`)
  const current = await liveState(stateFile)
  if (current) return current
  const logFile = resolve(runtimeDir, `${key}.log`)
  const log = openSync(logFile, 'a', 0o600)
  const endpointKey = createHash('sha256').update(serverUrl).digest('hex').slice(0, 16)
  const config = {
    stateFile, parentPid: process.pid, serverUrl, username, password, python,
    directory: ctx.directory || root,
    dataDir: resolve(runtimeDir, 'data', endpointKey),
    connectionMode: ctx.vibetraceConnectionMode || 'direct',
    reportedServerUrl: ctx.vibetraceReportedServerUrl || serverUrl,
  }
  const child = spawn(node, [resolve(root, 'plugins/runtime.mjs')], { cwd: root, detached: true, stdio: ['ignore', log, log], env: { ...process.env, VIBETRACE_RUNTIME_CONFIG: JSON.stringify(config) } })
  closeSync(log)
  let failure
  child.on('error', e => { failure = e })
  child.unref()
  for (let i = 0; i < 100; i++) {
    if (failure) throw failure
    if (child.exitCode !== null) throw new Error(`VibeTrace exited; see ${logFile}`)
    const state = await liveState(stateFile)
    if (state) return state
    await new Promise(ok => setTimeout(ok, 250))
  }
  child.kill('SIGTERM')
  throw new Error(`VibeTrace startup timed out; see ${logFile}`)
}
