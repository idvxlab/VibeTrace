import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

function modelRef(value) {
  if (typeof value !== 'string' || !/^[^\s/]+\/\S+$/.test(value.trim())) throw new Error('Model must use providerID/modelID, matching a model configured in OpenCode.')
  return value.trim()
}

export function readModelConfig(file) {
  if (!existsSync(file)) return {}
  const value = JSON.parse(readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid VibeTrace configuration: ${file}`)
  return value
}

export function writeModelConfig(file, patch) {
  const previous = readModelConfig(file)
  const next = { ...previous }
  for (const key of ['backgroundModel', 'skillEvolutionModel']) {
    if (patch[key] === null) delete next[key]
    else if (patch[key] !== undefined) next[key] = modelRef(patch[key])
  }
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temp, file)
  } finally { if (existsSync(temp)) unlinkSync(temp) }
  return next
}

export function workerModelEnvironment(runtimeDir, options = {}, env = process.env) {
  const saved = readModelConfig(resolve(runtimeDir, 'config.json'))
  const background = options.backgroundModel || env.MW_OPENCODE_MODEL || saved.backgroundModel
  const skill = options.skillEvolutionModel || env.MW_SKILL_EVOLVE_MODEL || saved.skillEvolutionModel
  return {
    ...(background ? { MW_OPENCODE_MODEL: modelRef(background) } : {}),
    ...(skill ? { MW_SKILL_EVOLVE_MODEL: modelRef(skill) } : {}),
  }
}
