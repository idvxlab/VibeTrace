import { ensureRuntime, openBrowser } from './launcher.mjs'
import { sdkBridge } from './bridge.mjs'

const opened = new Set()
export function needsSdkBridge(serverUrl) {
  const url = new URL(serverUrl)
  // OpenCode currently supplies this value when the TUI uses its in-process
  // transport and no HTTP server exists. It is a placeholder, not an endpoint.
  return url.protocol === 'http:' && url.hostname === 'localhost' && url.port === '4096'
}

export async function runtimeContext(ctx) {
  if (!needsSdkBridge(ctx.serverUrl)) return { ...ctx, vibetraceConnectionMode: 'direct' }
  const bridge = await sdkBridge(ctx)
  return {
    ...ctx,
    serverUrl: new URL(bridge.url),
    vibetraceAuth: bridge,
    vibetraceConnectionMode: 'sdk-bridge',
    vibetraceReportedServerUrl: ctx.serverUrl.toString(),
  }
}

async function server(ctx, options) {
  // Do not delay OpenCode initialization or print into its terminal interface.
  void runtimeContext(ctx).then(runtimeCtx => ensureRuntime(runtimeCtx, options)).then(state => {
    if (!opened.has(state.url) && process.env.VIBETRACE_NO_BROWSER !== '1') {
      opened.add(state.url)
      openBrowser(state.url)
    }
    return ctx.client.app.log({ body: { service: 'vibetrace', level: 'info', message: `VibeTrace ready: ${state.url}` } })
  }).catch(error => {
    void ctx.client.app.log({ body: { service: 'vibetrace', level: 'error', message: String(error) } }).catch(() => {})
  })
  return {}
}
export default { id: 'vibetrace', server }
