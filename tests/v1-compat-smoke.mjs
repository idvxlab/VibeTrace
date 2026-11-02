// Run an installed package against an isolated real V1 host, without model calls.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, realpathSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const binary = process.env.VIBETRACE_TEST_OPENCODE
const nativeFetch = globalThis.fetch
globalThis.fetch = (url, options = {}) => nativeFetch(url, { ...options, signal: options.signal || AbortSignal.timeout(60000) })
if (!binary) throw new Error('Set VIBETRACE_TEST_OPENCODE to a real V1 executable')
const packageRoot = resolve(process.env.VIBETRACE_TEST_PACKAGE_ROOT || '.')
const temp = mkdtempSync(resolve(tmpdir(), 'vibetrace-v1-real-'))
const config = resolve(temp, 'config/opencode/opencode.jsonc')
const states = resolve(temp, 'states')
mkdirSync(dirname(config), { recursive: true })
writeFileSync(config, '{\n // keep my preferences\n "plugin": [],\n}\n')
if (process.env.VIBETRACE_TEST_PREPARED_CONFIG) {
  for (const name of ['node_modules', 'package.json', 'package-lock.json']) cpSync(resolve(process.env.VIBETRACE_TEST_PREPARED_CONFIG, name), resolve(dirname(config), name), { recursive: true })
}
const env = { ...process.env, PATH: dirname(binary) + delimiter + process.env.PATH,
  HOME: temp, XDG_CONFIG_HOME: resolve(temp, 'config'), XDG_DATA_HOME: resolve(temp, 'data'),
  XDG_CACHE_HOME: resolve(temp, 'cache'), XDG_STATE_HOME: resolve(temp, 'state'),
  OPENCODE_CONFIG: config, OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_CONFIG_DIR: '',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
  VIBETRACE_RUNTIME_DIR: states, VIBETRACE_NO_BROWSER: '1', OPENCODE_SERVER_PASSWORD: 'v1-test-only' }
if (process.env.VIBETRACE_TEST_NO_PROXY === '1') {
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name]
}
const cli = resolve(packageRoot, 'scripts/vibetrace.mjs')
for (let i = 0; i < 2; i++) {
  const result = spawnSync(process.execPath, [cli, 'setup'], { env, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stderr + result.stdout)
}
const text = readFileSync(config, 'utf8')
assert.match(text, /keep my preferences/)
const { default: jsonc } = await import('jsonc-parser')
const entries = jsonc.parse(text).plugin
assert.equal(entries.length, 1)
assert.match(entries[0], /^file:/)
const installedRoot = resolve(dirname(fileURLToPath(entries[0])), '..')
assert.notEqual(installedRoot, packageRoot, 'runtime survives removal of the npx cache')
const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output = (output + data).slice(-20000) })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, label) {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`OpenCode exited: ${output}`)
    const value = await fn()
    if (value) return value
    await pause(200)
  }
  throw new Error(`Timed out: ${label}; artifacts: ${temp}\n${output}`)
}
let state
let electronChild
let electronState
try {
  const base = await until(() => output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], 'server')
  const headers = { authorization: 'Basic ' + Buffer.from('opencode:v1-test-only').toString('base64') }
  assert.equal((await fetch(base + '/session', { headers })).status, 200)
  state = await until(() => {
    try { const file = readdirSync(states).find(f => f.endsWith('.json')); return file && JSON.parse(readFileSync(resolve(states, file), 'utf8')) } catch { return null }
  }, 'VibeTrace runtime')
  assert.equal(realpathSync(state.root), realpathSync(installedRoot))
  assert.equal((await fetch(state.url)).status, 200)
  assert.equal((await (await fetch(state.url + '/health')).json()).service, 'memory-worker-python')
  const status = spawnSync(process.execPath, [cli, 'status'], { env, encoding: 'utf8' })
  assert.equal(status.status, 0, status.stderr)
  assert.match(status.stdout, /Running:/, 'npx CLI discovers persistent runtime snapshots')
  const created = await fetch(state.url + '/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'V1 compatibility test' }) })
  assert.equal(created.status, 200)
  const session = await created.json()
  assert.ok(session.id)
  const sessions = await (await fetch(state.url + '/session')).json()
  assert.ok(sessions.some(s => s.id === session.id))
  assert.equal((await fetch(state.url + `/session/${session.id}/message`)).status, 200)
  const events = await fetch(state.url + '/global/event', { signal: AbortSignal.timeout(5000) })
  assert.equal(events.status, 200)
  await events.body.cancel()
  if (process.env.VIBETRACE_TEST_ELECTRON) {
    const electronStates = resolve(temp, 'electron-states')
    electronChild = spawn(process.env.VIBETRACE_TEST_ELECTRON, ['--input-type=module', '-e', `
      import { ensureRuntime } from ${JSON.stringify(pathToFileURL(resolve(installedRoot, 'plugins/launcher.mjs')).href)};
      if (!process.versions.electron) throw new Error('Expected actual Electron runtime');
      setInterval(() => {}, 1000);
      await ensureRuntime({ serverUrl: new URL(${JSON.stringify(base)}), directory: ${JSON.stringify(temp)} });
    `], { env: { ...env, ELECTRON_RUN_AS_NODE: '1', VIBETRACE_RUNTIME_DIR: electronStates }, stdio: ['ignore', 'pipe', 'pipe'] })
    let electronOutput = ''
    for (const stream of [electronChild.stdout, electronChild.stderr]) stream.on('data', data => { electronOutput += data })
    electronState = await until(() => {
      if (electronChild.exitCode !== null) throw new Error(electronOutput)
      try { const file = readdirSync(electronStates).find(f => f.endsWith('.json')); return file && JSON.parse(readFileSync(resolve(electronStates, file), 'utf8')) } catch { return null }
    }, 'Electron-hosted runtime')
    assert.equal((await fetch(electronState.url)).status, 200)
    assert.equal((await (await fetch(electronState.url + '/health')).json()).service, 'memory-worker-python')
    console.log('PASS: installed Desktop Electron executable starts standalone Node, dashboard and Python (not a full GUI test)')
  }
  const result = spawnSync(process.execPath, [cli, 'uninstall'], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(jsonc.parse(readFileSync(config, 'utf8')).plugin, [])
  console.log(`PASS: setup twice, persistent runtime, UI/Python, session creation/list/messages, SSE and uninstall; ${temp}`)
} finally {
  electronChild?.kill('SIGTERM')
  child.kill('SIGTERM')
  await pause(5000)
  if (state) {
    let alive = false
    try { alive = (await fetch(state.url + '/health', { signal: AbortSignal.timeout(500) })).ok } catch {}
    assert.equal(alive, false, 'owned services exit with OpenCode')
  }
  if (electronState) {
    let alive = false
    try { alive = (await fetch(electronState.url + '/health', { signal: AbortSignal.timeout(500) })).ok } catch {}
    assert.equal(alive, false, 'owned services exit with Electron')
  }
}
