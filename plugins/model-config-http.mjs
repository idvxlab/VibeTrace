import { resolve, dirname } from 'node:path'
import { readModelConfig, writeModelConfig } from './model-config.mjs'

/** Same-origin local settings endpoint. The caller checks host and Origin first. */
export async function handleModelConfigRequest(req, res, stateFile) {
  const file = resolve(dirname(stateFile), 'config.json')
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'GET') {
    try {
      const saved = readModelConfig(file)
      send(200, { backgroundModel: saved.backgroundModel || '', skillEvolutionModel: saved.skillEvolutionModel || '' })
    } catch (error) { send(500, { error: error.message }) }
    return
  }
  if (req.method !== 'PUT') { send(405, { error: 'Use GET or PUT' }); return }
  try {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 8192) { send(413, { error: 'Settings request is too large' }); return }
    }
    const input = JSON.parse(raw)
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['backgroundModel', 'skillEvolutionModel'].includes(key))) {
      send(400, { error: 'Invalid model settings' }); return
    }
    const patch = {}
    for (const key of ['backgroundModel', 'skillEvolutionModel']) {
      if (!(key in input)) continue
      if (input[key] !== null && typeof input[key] !== 'string') { send(400, { error: `${key} must be a model ref or null` }); return }
      patch[key] = input[key]
    }
    if (!Object.keys(patch).length) { send(400, { error: 'No model setting supplied' }); return }
    const saved = writeModelConfig(file, patch)
    send(200, { backgroundModel: saved.backgroundModel || '', skillEvolutionModel: saved.skillEvolutionModel || '' })
  } catch (error) {
    send(error instanceof SyntaxError || /Model must use/.test(error.message) ? 400 : 500, { error: error.message })
  }
}
