import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'

let pending
// A plain TUI may have no HTTP listener. Use the SDK transport OpenCode gives
// the plugin, which reaches this instance even when serverUrl is only a default.
export function sdkBridge(ctx) {
  if (pending) return pending
  pending = start(ctx).catch(error => { pending = undefined; throw error })
  return pending
}
async function start(ctx) {
  const client = ctx.client._client || ctx.client.client
  const config = client?.getConfig?.()
  if (typeof config?.fetch !== 'function') throw new Error('Unsupported OpenCode SDK transport; VibeTrace cannot safely identify this instance')
  const username = 'vibetrace'
  const password = randomBytes(32).toString('hex')
  const authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== authorization) { res.writeHead(401); res.end(); return }
    const abort = new AbortController()
    req.on('aborted', () => abort.abort())
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })
    try {
      const url = new URL(config.baseUrl || ctx.serverUrl)
      const incoming = new URL(req.url, 'http://localhost')
      url.pathname = incoming.pathname
      url.search = incoming.search
      const headers = new Headers(config.headers)
      for (const [key, value] of Object.entries(req.headers)) {
        if (['authorization', 'host', 'connection', 'content-length', 'transfer-encoding'].includes(key) || value === undefined) continue
        headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      }
      const request = new Request(url, { method: req.method, headers, signal: abort.signal,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      })
      const response = await config.fetch(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) {
        const stream = Readable.fromWeb(response.body)
        stream.on('error', () => {
          if (!res.destroyed) res.destroy()
        })
        stream.pipe(res)
      } else res.end()
    } catch (error) {
      if (abort.signal.aborted) return
      if (!res.headersSent) {
        res.writeHead(502)
        res.end('VibeTrace OpenCode bridge unavailable')
      } else if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : undefined)
      }
    }
  })
  await new Promise((ok, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ok) })
  server.unref()
  return { url: `http://127.0.0.1:${server.address().port}`, username, password }
}
