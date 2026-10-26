// Real OpenCode server; no prompts are sent and no model calls are made.
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { needsSdkBridge } from '../plugins/vibetrace.mjs'
import { nodeExecutable } from '../plugins/launcher.mjs'
// Desktop exposes an Electron helper as execPath; never attempt to execute it.
const forbiddenHelper = resolve(tmpdir(), 'not-a-node-electron-helper')
assert.equal(nodeExecutable(undefined, { versions: { electron: 'desktop' }, execPath: forbiddenHelper }), process.execPath)
assert.equal(nodeExecutable(undefined, { versions: { bun: 'terminal' }, execPath: forbiddenHelper }), process.execPath)
assert.equal(nodeExecutable(process.execPath), process.execPath)
assert.throws(() => nodeExecutable(forbiddenHelper), /could not start Node.js/)
assert.throws(() => nodeExecutable('/usr/bin/true'), /could not start Node.js/)
const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
assert.equal(packageJson.main, './plugins/vibetrace.mjs', 'OpenCode v1 needs a server main entrypoint')
assert.equal(packageJson.exports?.['./server'], packageJson.main, 'server subpath should resolve to the same plugin entrypoint')
assert.equal(typeof (await import('../plugins/vibetrace.mjs')).default?.server, 'function', 'server entrypoint exports a V1 plugin module')
assert.equal(needsSdkBridge(new URL('http://localhost:4096')), true)
assert.equal(needsSdkBridge(new URL('http://127.0.0.1:4096')), false)
assert.equal(needsSdkBridge(new URL('http://127.0.0.1:54321')), false)
const root = resolve('.')
const temp = mkdtempSync(resolve(tmpdir(), 'vibetrace-smoke-'))
const states = resolve(temp, 'runtime')
mkdirSync(resolve(temp, 'opencode'), { recursive: true })
const config = resolve(temp, 'opencode/opencode.json')
writeFileSync(config, JSON.stringify({}))
const installed = spawnSync(process.execPath, ['scripts/vibetrace.mjs', 'install', '--plugin-dir', resolve(temp, 'opencode/plugins')], { encoding: 'utf8' })
assert.equal(installed.status, 0, installed.stderr)
const blocker = http.createServer((req, res) => res.end('unrelated service'))
let ownsBlocker = false
await new Promise((ok, reject) => {
  blocker.once('error', error => error.code === 'EADDRINUSE' ? ok() : reject(error))
  blocker.listen(5174, '127.0.0.1', () => { ownsBlocker = true; ok() })
})
const password = 'vibetrace-smoke-only'
const auth = { Authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'), 'x-opencode-directory': root }
const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XDG_CONFIG_HOME: temp, OPENCODE_CONFIG: config, VIBETRACE_RUNTIME_DIR: states, VIBETRACE_NO_BROWSER: '1', OPENCODE_SERVER_PASSWORD: password } })
let output = ''
child.stdout.on('data', data => { output += data })
child.stderr.on('data', data => { output += data })
const wait = ms => new Promise(ok => setTimeout(ok, ms))
async function until(fn, label) {
  for (let i = 0; i < 150; i++) { const value = await fn(); if (value) return value; if (child.exitCode !== null) throw new Error(output); await wait(200) }
  throw new Error(`Timed out: ${label}\n${output}\nLogs: ${temp}`)
}
let state
let desktopChild
let desktopState
try {
  const base = await until(() => output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], 'OpenCode startup')
  const sessions = await fetch(`${base}/session`, { headers: auth })
  assert.equal(sessions.status, 200)
  state = await until(() => {
    try { const file = readdirSync(states).find(f => f.endsWith('.json')); return file && JSON.parse(readFileSync(resolve(states, file), 'utf8')) } catch { return null }
  }, 'plugin runtime startup')
  assert.equal(state.parentPid, child.pid)
  assert.equal(state.root, root)
  assert.equal(state.connectionMode, 'direct')
  assert.equal(state.serverUrl.replace(/\/$/, ''), base)
  assert.notEqual(state.url, 'http://127.0.0.1:5174', 'occupied UI port is not taken over')
  assert.equal((await fetch(state.url)).status, 200)
  const health = await (await fetch(`${state.url}/health`)).json()
  assert.equal(health.service, 'memory-worker-python')
  assert.equal(health.opencodeBase.replace(/\/$/, ''), state.serverUrl.replace(/\/$/, ''))
  assert.equal((await fetch(`${state.url}/session`, { headers: { 'x-opencode-directory': root } })).status, 200)
  const sse = await fetch(`${state.url}/global/event`, { signal: AbortSignal.timeout(3000) })
  assert.equal(sse.status, 200)
  assert.match(sse.headers.get('content-type'), /text\/event-stream/)
  const reader = sse.body.getReader()
  assert.equal((await reader.read()).done, false)
  await reader.cancel()
  assert.equal((await fetch(`${state.url}/health`, { headers: { Origin: 'https://example.com' } })).status, 403)
  await fetch(`${base}/session`, { headers: { ...auth, 'x-opencode-directory': temp } })
  await wait(500)
  assert.equal(readdirSync(states).filter(f => f.endsWith('.json')).length, 1, 'multiple project contexts reuse runtime')
  console.log(`PASS: installed wrapper auto-loaded; UI, worker, authenticated API/SSE proxy, port conflict, origin check and reuse. ${state.url}`)
  const electron = process.env.VIBETRACE_TEST_ELECTRON || '/Applications/OpenCode.app/Contents/MacOS/OpenCode'
  if (existsSync(electron)) {
    const desktopStates = resolve(temp, 'desktop-runtime')
    // Exercise the installed desktop's actual Electron runtime, without opening
    // a window or changing the user's desktop configuration or conversations.
    desktopChild = spawn(electron, ['--input-type=module', '-e', `
      import { ensureRuntime } from ${JSON.stringify(new URL('../plugins/launcher.mjs', import.meta.url).href)};
      if (!process.versions.electron) throw new Error('Expected Electron host');
      const keepAlive = setInterval(() => {}, 1000);
      const state = await ensureRuntime({ serverUrl: new URL(${JSON.stringify(base)}), directory: ${JSON.stringify(root)} });
      console.log(JSON.stringify(state));
    `], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENCODE_SERVER_PASSWORD: password, VIBETRACE_RUNTIME_DIR: desktopStates } })
    let desktopOutput = ''
    desktopChild.stderr.on('data', data => { desktopOutput += data })
    desktopChild.stdout.on('data', data => { desktopOutput += data })
    desktopState = await until(() => {
      if (desktopChild.exitCode !== null) throw new Error(desktopOutput)
      try { const file = readdirSync(desktopStates).find(f => f.endsWith('.json')); return file && JSON.parse(readFileSync(resolve(desktopStates, file), 'utf8')) } catch { return null }
    }, 'Electron-hosted plugin startup')
    assert.equal(desktopState.parentPid, desktopChild.pid)
    assert.equal(desktopState.serverUrl.replace(/\/$/, ''), base)
    assert.equal((await fetch(desktopState.url)).status, 200)
    assert.equal((await fetch(`${desktopState.url}/session`, { headers: { 'x-opencode-directory': root } })).status, 200)
    const desktopHealth = await (await fetch(`${desktopState.url}/health`)).json()
    assert.equal(desktopHealth.service, 'memory-worker-python')
    console.log('PASS: actual Electron host starts standalone Node, UI and Python worker; authenticated random-port OpenCode connection works.')
  }
} finally {
  desktopChild?.kill('SIGTERM')
  child.kill('SIGTERM')
  if (ownsBlocker) blocker.close()
  await wait(5000)
  if (desktopState) {
    let alive = true
    try { await fetch(`${desktopState.url}/health`, { signal: AbortSignal.timeout(500) }) } catch { alive = false }
    assert.equal(alive, false, 'runtime exits after Electron host exits')
  }
  if (state) {
    let alive = true
    try { await fetch(`${state.url}/health`, { signal: AbortSignal.timeout(500) }) } catch { alive = false }
    assert.equal(alive, false, 'runtime exits after OpenCode exits')
    console.log('PASS: owned services stop when OpenCode exits; existing manual services untouched.')
  }
}
