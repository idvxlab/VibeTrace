import { sdkBridge } from './bridge.mjs'

export function needsSdkBridge(serverUrl) {
  if (!serverUrl) return true
  const url = new URL(serverUrl)
  return url.protocol === 'http:' && url.hostname === 'localhost' && url.port === '4096'
}

export async function runtimeContext(ctx) {
  if (!needsSdkBridge(ctx.serverUrl)) return { ...ctx, vibetraceConnectionMode: 'direct' }
  const bridge = await sdkBridge(ctx)
  return {
    ...ctx, serverUrl: new URL(bridge.url), vibetraceAuth: bridge,
    vibetraceConnectionMode: 'sdk-bridge',
    vibetraceReportedServerUrl: ctx.serverUrl?.toString() || 'in-process SDK transport',
  }
}
