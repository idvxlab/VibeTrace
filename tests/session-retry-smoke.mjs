// Exercise the built UI in an isolated Chrome profile with a fake OpenCode API.
// No user configuration, real OpenCode sessions, or external model calls are used.
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, extname } from 'node:path'

const chromePath = process.env.VIBETRACE_TEST_CHROME ||
  (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
const sessions = []
const messages = new Map()
const sends = []
let creates = 0
let failNextCreate = false
let releaseCreate
let delayNextCreate = false
const sockets = new Set()
const eventClients = new Set()
const emit = event => { for (const client of eventClients) client.write(`data: ${JSON.stringify(event)}\n\n`) }
const pause = ms => new Promise(ok => setTimeout(ok, ms))
async function until(check, label) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return
    await pause(100)
  }
  throw new Error(`Timed out: ${label}`)
}

const fixture = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture')
  const path = url.pathname
  const json = (body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (path === '/global/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"server.connected","properties":{}}\n\n')
    eventClients.add(res)
    res.on('close', () => eventClients.delete(res))
    return
  }
  if (path === '/path') return json({ directory: '/test/fresh' })
  if (path === '/project') return json([{ id: 'project', worktree: '/test/fresh' }])
  if (path === '/project/current') return json({ id: 'project', worktree: '/test/fresh' })
  if (path === '/config/providers') return json({ providers: [
    { id: 'fixture', name: 'Fixture', models: { test: { id: 'test', name: 'Test', cost: { input: 0, output: 0 } } } },
  ], default: { fixture: 'test' } })
  if (path === '/session/status') return json({})
  if (path === '/session') {
    if (req.method === 'POST') {
      creates++
      for await (const _ of req) { /* consume request */ }
      if (failNextCreate) {
        failNextCreate = false
        return json({ error: 'fixture create failure' }, 500)
      }
      if (delayNextCreate) {
        delayNextCreate = false
        await new Promise(ok => { releaseCreate = ok })
      }
      const session = { id: `ses_fixture_${creates}`, title: `Fixture conversation ${creates}`,
        slug: `fixture-${creates}`, projectID: 'project', version: '2.1.4',
        directory: req.headers['x-opencode-directory'] || '/test/fresh',
        summary: { additions: 0, deletions: 0, files: 0 }, time: { created: Date.now(), updated: Date.now() } }
      sessions.push(session)
      return json(session)
    }
    const directory = url.searchParams.get('directory')?.replaceAll('\\', '/')
    return json(directory ? sessions.filter(s => s.directory === directory) : sessions)
  }
  const messageMatch = path.match(/^\/session\/([^/]+)\/message$/)
  if (messageMatch) {
    const sid = messageMatch[1]
    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const payload = JSON.parse(body)
      sends.push({ sid, directory: req.headers['x-opencode-directory'], payload })
      const history = messages.get(sid) || []
      for (const role of ['user', 'assistant']) {
        const id = `msg_fixture_${sends.length}_${role}`
        history.push({ info: { id, sessionID: sid, role, time: { created: Date.now(), completed: Date.now() },
          ...(role === 'assistant' ? { finish: 'stop' } : {}) },
          parts: [{ id: `${id}_text`, sessionID: sid, messageID: id, type: 'text',
            text: role === 'user' ? payload.parts.find(p => p.type === 'text').text : `Fixture reply ${sends.length}` }] })
      }
      messages.set(sid, history)
      return json({})
    }
    return json(messages.get(sid) || [])
  }
  if (path.endsWith('/todo') || path === '/permission' || path === '/question') return json([])
  if (['/task-switch-prompt', '/task-segments', '/panel-analysis', '/task-skills', '/ingest-trace'].includes(path)) {
    return json({ ok: true, tabs: [], items: [], skills: [] })
  }
  if (path === '/' || path.startsWith('/assets/')) {
    const file = resolve('dist', path === '/' ? 'index.html' : `.${path}`)
    if (existsSync(file)) {
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' })
      return res.end(readFileSync(file))
    }
  }
  json({ error: `Missing fixture: ${path}` }, 404)
})
fixture.on('connection', socket => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})

let chrome
let ws
const profile = mkdtempSync(resolve(tmpdir(), 'vibetrace-composer-'))
try {
  await new Promise((ok, reject) => {
    fixture.once('error', reject)
    fixture.listen(0, '127.0.0.1', ok)
  })
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
  chrome.on('error', error => { console.error(error.message) })
  const portFile = resolve(profile, 'DevToolsActivePort')
  await until(() => existsSync(portFile), 'isolated browser starts')
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((ok, reject) => { ws.addEventListener('open', ok); ws.addEventListener('error', reject) })
  let nextID = 0
  const pending = new Map()
  const errors = []
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data)
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text)
    const promise = pending.get(data.id)
    if (promise) {
      pending.delete(data.id)
      if (data.error) promise.reject(new Error(data.error.message))
      else promise.resolve(data.result)
    }
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextID
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const ready = () => until(() => evaluate('!!document.querySelector("textarea") && !document.querySelector("textarea").disabled'), 'composer enabled')
  const send = async text => {
    await ready()
    await evaluate(`(() => {
      const input = document.querySelector('textarea'); input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  const addFolder = async directory => {
    await evaluate(`window.prompt = () => ${JSON.stringify(directory)}; document.querySelector('button[title="Add workspace directory"]').click()`)
    await ready()
  }
  await cdp('Runtime.enable')
  await cdp('Page.navigate', { url: `http://127.0.0.1:${fixture.address().port}/` })
  await ready()
  assert.equal(creates, 0, 'opening a fresh workspace must not create empty history')
  await send('First message')
  await until(() => sends.length === 1, 'first message delivered')
  assert.equal(creates, 1)
  assert.equal(sends[0].directory, '/test/fresh')
  assert.ok(sends[0].payload.parts.some(p => p.text?.includes('First message')))
  await until(() => evaluate('document.body.innerText.includes("Fixture reply 1")'), 'first reply visible')
  await until(() => eventClients.size > 0, 'SSE connected')
  const sid = sends[0].sid
  const status = (type, extra = {}, sessionID = sid) => emit({ type: 'session.status', properties: { sessionID, status: { type, ...extra } } })
  const alert = () => evaluate("document.querySelector('[role=\"alert\"]')?.innerText || ''")
  status('retry', { message: 'Background retry must stay hidden', attempt: 1, next: Date.now() + 20000 }, 'background')
  await pause(300)
  assert.equal(await alert(), '')
  const next = Date.now() + 11542000
  status('retry', { message: 'Free usage exceeded, subscribe to Go', attempt: 1, next })
  await until(async () => (await alert()).includes('Free usage exceeded, subscribe to Go'), 'retry card visible')
  const first = await alert()
  assert.match(first, /OpenCode request retrying/)
  assert.match(first, /attempt 1/)
  const seconds = text => Number(text.match(/Retrying in (\d+)s/)[1])
  assert.ok(Math.abs(seconds(first) - 11542) <= 1)
  await until(async () => seconds(await alert()) < seconds(first), 'live countdown ticks')
  status('retry', { message: 'Free usage exceeded, subscribe to Go', attempt: 2, next: Date.now() + 30000 })
  await until(async () => (await alert()).includes('attempt 2'), 'attempt updates')
  status('busy')
  await until(async () => !(await alert()), 'busy clears retry')
  status('retry', { message: 'Retry again', attempt: 3, next: Date.now() - 1000 })
  await until(async () => (await alert()).includes('Retrying in 0s'), 'past timestamps clamp to zero')
  status('idle')
  await until(async () => !(await alert()), 'idle clears retry')
  status('retry', { message: 'Last retry', attempt: 4, next: Date.now() + 30000 })
  await until(async () => (await alert()).includes('Last retry'), 'retry before failure')
  emit({ type: 'session.error', properties: { sessionID: sid, error: { name: 'APIError', data: { message: 'Insufficient Balance' } } } })
  await until(async () => (await alert()).includes('OpenCode request failed') && (await alert()).includes('Insufficient Balance'), 'final failure replaces retry')
  await send('New turn clears failure')
  await until(async () => !(await alert()), 'new turn clears card')
  assert.deepEqual(errors, [], 'no uncaught browser exceptions')
  console.log('PASS: built UI + real SSE: retry message, ticking countdown, attempt updates, session isolation, busy/idle clearing, final failure and new turn')
} finally {
  ws?.close()
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(ok => chrome.once('exit', ok))
    chrome.kill('SIGTERM')
    await exited
  }
  for (const socket of sockets) socket.destroy()
  await new Promise(ok => fixture.close(ok))
  rmSync(profile, { recursive: true, force: true })
}
