import http from 'node:http'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, resolve, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(process.env.VIBETRACE_RUNTIME_CONFIG)
const stateFile = config.stateFile
mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 })
const workerPaths = ['/health', '/ingest-trace', '/task-switch-prompt', '/fork-inherit-task-state', '/task-skills', '/task-skill-detail', '/task-skill-save', '/task-feedback-distill', '/panel-analysis', '/task-segments']
const apiPaths = ['/session', '/project', '/path', '/config', '/question', '/permission', '/api', '/global', '/provider', '/agent', '/event']
const matches = (pathname, paths) => paths.some(p => pathname === p || pathname.startsWith(p + '/'))
let worker, server, stopping = false, timer
function stop() {
  if (stopping) return
  stopping = true
  clearInterval(timer)
  try { unlinkSync(stateFile) } catch {}
  worker?.kill('SIGTERM')
  server?.close()
  setTimeout(() => { worker?.kill('SIGKILL'); process.exit(0) }, 1500).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('uncaughtException', e => { console.error(e); stop() })

function proxy(req, res, base, authenticated) {
  const target = new URL(base)
  const requestUrl = new URL(req.url, 'http://localhost')
  target.pathname = requestUrl.pathname
  target.search = requestUrl.search
  const headers = { ...req.headers, host: target.host }
  delete headers.authorization
  if (authenticated && config.password) headers.authorization = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64')
  const upstream = http.request(target, { method: req.method, headers }, incoming => {
    const responseHeaders = { ...incoming.headers }
    delete responseHeaders['www-authenticate']
    res.writeHead(incoming.statusCode, responseHeaders)
    incoming.pipe(res)
  })
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('VibeTrace upstream unavailable') })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

async function main() {
  if (!existsSync(resolve(root, 'dist/index.html'))) throw new Error('Build the UI first: npm run build:plugin')
  const workerPort = await new Promise((resolvePort, reject) => {
    worker = spawn(config.python, ['-u', resolve(root, 'memory_worker/server.py')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        VIBETRACE_PLUGIN_MODE: '1', VIBETRACE_DATA_DIR: config.dataDir,
        MEMORY_WORKER_PORT: '0', OPENCODE_BASE: config.serverUrl,
        OPENCODE_DIRECTORY: config.directory,
        OPENCODE_SERVER_PASSWORD: config.password, OPENCODE_SERVER_USERNAME: config.username,
      },
    })
    const timeout = setTimeout(() => reject(new Error('Python worker startup timed out; see runtime log')), 20000)
    let buffer = ''
    worker.stdout.on('data', data => {
      process.stdout.write(data)
      buffer = (buffer + data).slice(-8192)
      const match = buffer.match(/VIBETRACE_WORKER_READY=(\d+)/)
      if (match) { clearTimeout(timeout); resolvePort(Number(match[1])) }
    })
    worker.stderr.pipe(process.stderr)
    worker.once('error', e => { clearTimeout(timeout); reject(e) })
    worker.once('exit', () => { clearTimeout(timeout); reject(new Error('Python worker exited')); stop() })
  })
  server = http.createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403); res.end(); return }
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end(); return }
    const pathname = new URL(req.url, 'http://localhost').pathname
    if (pathname === '/__vibetrace/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ service: 'vibetrace-plugin', root, parentPid: config.parentPid, serverUrl: config.serverUrl, connectionMode: config.connectionMode, reportedServerUrl: config.reportedServerUrl, workerPort }))
      return
    }
    if (matches(pathname, workerPaths)) return proxy(req, res, `http://127.0.0.1:${workerPort}`, false)
    if (matches(pathname, apiPaths)) return proxy(req, res, config.serverUrl, true)
    let file
    try { file = resolve(root, 'dist', '.' + decodeURIComponent(pathname)) } catch { res.writeHead(400); res.end(); return }
    const dist = resolve(root, 'dist')
    if (!file.startsWith(dist + sep) && file !== dist) { res.writeHead(403); res.end(); return }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
    if (pathname === '/' || !extname(pathname)) file = resolve(dist, 'index.html')
    if (!existsSync(file)) { res.writeHead(404); res.end(); return }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' })
    if (req.method === 'HEAD') return res.end()
    const stream = createReadStream(file)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  })
  await new Promise((ok, reject) => {
    const onError = error => {
      if (error.code === 'EADDRINUSE') { server.once('error', reject); server.listen(0, '127.0.0.1', ok) }
      else reject(error)
    }
    server.once('error', onError)
    server.listen(5174, '127.0.0.1', () => { server.removeListener('error', onError); ok() })
  })
  const url = `http://127.0.0.1:${server.address().port}`
  writeFileSync(stateFile, JSON.stringify({ url, pid: process.pid, parentPid: config.parentPid, root, serverUrl: config.serverUrl, connectionMode: config.connectionMode, reportedServerUrl: config.reportedServerUrl, workerPort }), { mode: 0o600 })
  console.log(`VIBETRACE_READY=${url}`)
  timer = setInterval(() => { try { process.kill(config.parentPid, 0) } catch { stop() } }, 2000)
}
main().catch(e => { console.error(e); stop() })
