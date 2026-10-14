import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { ProxyOptions } from 'vite'

/** OpenCode REST/SSE paths — proxied by Vite dev server to OpenCode */
const OPENCODE_PROXY_PREFIXES = [
  '/session',
  '/project',
  '/path',
  '/config',
  '/question',
  '/permission',
  '/api',
  '/global',
] as const

function basicAuthFromEnv(env: Record<string, string>): string | null {
  const pwd = env.VITE_OPENCODE_SERVER_PASSWORD?.trim() || env.OPENCODE_SERVER_PASSWORD?.trim()
  if (!pwd) return null
  const user =
    env.VITE_OPENCODE_SERVER_USERNAME?.trim() ||
    env.OPENCODE_SERVER_USERNAME?.trim() ||
    'opencode'
  return `Basic ${Buffer.from(`${user}:${pwd}`).toString('base64')}`
}

function opencodeProxyRules(target: string, env: Record<string, string>): Record<string, ProxyOptions> {
  const authHeader = basicAuthFromEnv(env)
  const rules: Record<string, ProxyOptions> = {}

  for (const prefix of OPENCODE_PROXY_PREFIXES) {
    rules[prefix] = {
      target,
      changeOrigin: true,
      // Long-lived `/global/event` SSE must not be cut by proxy idle timeouts
      timeout: 0,
      proxyTimeout: 0,
      configure: (proxy) => {
        proxy.on('proxyReq', (proxyReq, req) => {
          if (authHeader) proxyReq.setHeader('Authorization', authHeader)
          const url = req.url ?? ''
          if (url.includes('/event')) {
            proxyReq.setHeader('Accept', 'text/event-stream')
            proxyReq.setHeader('Cache-Control', 'no-cache')
          }
        })
        // Strip upstream WWW-Authenticate on 401 to avoid browser login dialog
        proxy.on('proxyRes', (proxyRes, req) => {
          delete proxyRes.headers['www-authenticate']
          delete proxyRes.headers['WWW-Authenticate']
          const url = req.url ?? ''
          if (url.includes('/event')) {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform'
            proxyRes.headers['x-accel-buffering'] = 'no'
          }
        })
      },
    }
  }
  return rules
}

function mergedOpencodeHttpBase(env: Record<string, string>): string {
  if ('VITE_OPENCODE_BASE' in env) {
    return (env.VITE_OPENCODE_BASE ?? '').trim().replace(/\/$/, '')
  }
  const raw = env.OPENCODE_BASE?.trim() || 'http://127.0.0.1:4096'
  return raw.replace(/\/$/, '')
}

function opencodeProxyTarget(env: Record<string, string>): string {
  const raw =
    env.OPENCODE_PROXY_TARGET?.trim() ||
    env.OPENCODE_BASE?.trim() ||
    'http://127.0.0.1:4096'
  return raw.replace(/\/$/, '')
}

function memoryWorkerProxyTarget(env: Record<string, string>): string {
  const raw =
    env.MEMORY_WORKER_PROXY_TARGET?.trim() ||
    env.VITE_MEMORY_WORKER_BASE?.trim() ||
    'http://127.0.0.1:8714'
  return raw.replace(/\/$/, '')
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const opencodeHttpBase = mergedOpencodeHttpBase(env)
  const proxyTarget = opencodeProxyTarget(env)
  const useProxy = opencodeHttpBase === '' && !!proxyTarget
  const mwTarget = memoryWorkerProxyTarget(env)
  const useMemoryWorkerProxy =
    useProxy && !(env.VITE_MEMORY_WORKER_BASE?.trim())

  const proxy = useProxy
    ? {
        ...opencodeProxyRules(proxyTarget, env),
        ...(useMemoryWorkerProxy
          ? {
              '/ingest-trace': { target: mwTarget, changeOrigin: true },
              '/task-switch-prompt': { target: mwTarget, changeOrigin: true },
              '/fork-inherit-task-state': { target: mwTarget, changeOrigin: true },
              '/task-skills': { target: mwTarget, changeOrigin: true },
              '/task-skill-detail': { target: mwTarget, changeOrigin: true },
              '/task-skill-save': { target: mwTarget, changeOrigin: true },
              '/task-feedback-distill': { target: mwTarget, changeOrigin: true },
              '/panel-analysis': { target: mwTarget, changeOrigin: true },
              '/task-segments': { target: mwTarget, changeOrigin: true },
              '/experiment-report': { target: mwTarget, changeOrigin: true },
              '/health': { target: mwTarget, changeOrigin: true },
            }
          : {}),
      }
    : {}

  if (useProxy) {
    const authOn = Boolean(basicAuthFromEnv(env))
    console.log(
      `[vibetrace] OpenCode proxy → ${proxyTarget} (basic auth: ${authOn ? 'on' : 'off'})`,
    )
  }

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      ...(Object.keys(proxy).length ? { proxy } : {}),
    },
    define: {
      __OPENCODE_HTTP_BASE__: JSON.stringify(
        useProxy ? '' : opencodeHttpBase || proxyTarget,
      ),
    },
  }
})
