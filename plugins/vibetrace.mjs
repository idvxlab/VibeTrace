import { ensureRuntime, openBrowser } from './launcher.mjs'
import { runtimeContext } from './v1-context.mjs'

const opened = new Set()
async function server(ctx, options) {
  // Do not delay OpenCode initialization or print into its terminal interface.
  void runtimeContext(ctx).then(runtimeCtx => ensureRuntime(runtimeCtx, options)).then(state => {
    if (!opened.has(state.url) && process.env.VIBETRACE_NO_BROWSER !== '1') {
      opened.add(state.url)
      openBrowser(state.url)
    }
    return log(ctx, 'info', `VibeTrace ready: ${state.url}`)
  }).catch(error => {
    void log(ctx, 'error', String(error))
  })
  return {}
}
async function log(ctx, level, message) {
  try { await ctx.client?.app?.log?.({ body: { service: 'vibetrace', level, message } }) } catch {}
}

// Older V1 loaders call exported functions; newer V1 also supports this form.
// Export initialization only once: old loaders invoke every function export.
export default async function VibeTrace(ctx, options = {}) {
  return server(ctx, options)
}
