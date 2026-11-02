#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root, runtimeDir, pythonExecutable, nodeExecutable, liveState, openBrowser } from '../plugins/launcher.mjs'
import { setup, doctor } from './setup.mjs'
import { configPaths, updateConfigs } from './config.mjs'
import { readModelConfig, writeModelConfig } from '../plugins/model-config.mjs'

const command = process.argv[2] || 'status'
const targetIndex = process.argv.indexOf('--plugin-dir')
const pluginDir = targetIndex >= 0 ? resolve(process.argv[targetIndex + 1]) : resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'), 'opencode/plugins')
const wrapper = resolve(pluginDir, 'vibetrace.js')
const marker = '// Managed by VibeTrace local installer\n'
const configIndex = process.argv.indexOf('--config')
if (configIndex >= 0 && (!process.argv[configIndex + 1] || process.argv[configIndex + 1].startsWith('--'))) throw new Error('--config requires a file path')
const explicitConfig = configIndex >= 0 ? process.argv[configIndex + 1] : undefined
if (targetIndex >= 0 && (!process.argv[targetIndex + 1] || process.argv[targetIndex + 1].startsWith('--'))) throw new Error('--plugin-dir requires a directory')
if (command === 'configure') {
  const patch = {}
  for (const [flag, key] of [['--background-model', 'backgroundModel'], ['--skill-model', 'skillEvolutionModel']]) {
    const index = process.argv.indexOf(flag)
    if (index < 0) continue
    if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`${flag} requires providerID/modelID`)
    patch[key] = process.argv[index + 1]
  }
  const file = resolve(runtimeDir, 'config.json')
  const saved = Object.keys(patch).length ? writeModelConfig(file, patch) : readModelConfig(file)
  console.log(`VibeTrace config: ${file}\nBackground analysis: ${saved.backgroundModel || 'opencode/big-pickle (default)'}\nSkill evolution: ${saved.skillEvolutionModel || 'inherits background model unless overridden by environment'}`)
  if (Object.keys(patch).length) console.log('Saved. Fully quit and reopen OpenCode to restart the worker with these models. Chat model selection is separate.')
} else if (command === 'setup' && !process.argv.includes('--local')) {
  setup(explicitConfig)
} else if (command === 'doctor') {
  console.log(JSON.stringify(doctor(), null, 2))
} else if (command === 'install' || command === 'setup' && process.argv.includes('--local')) {
  const runtimes = { python: pythonExecutable(), node: nodeExecutable() }
  if (!existsSync(resolve(root, 'dist/.vibetrace-plugin-build'))) throw new Error('First run npm run build:plugin')
  if (existsSync(wrapper) && !readFileSync(wrapper, 'utf8').startsWith(marker)) throw new Error(`Refusing to overwrite unrelated file: ${wrapper}`)
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(wrapper, marker + `import plugin from ${JSON.stringify(pathToFileURL(resolve(root, 'plugins/vibetrace.mjs')).href)};\nexport default ctx => plugin(ctx, ${JSON.stringify(runtimes)});\n`)
  console.log(`Installed local link: ${wrapper}\nSource: ${root}\nRestart OpenCode and open a project. Keep this source directory in place.`)
} else if (command === 'uninstall') {
  if (targetIndex < 0 && !process.argv.includes('--local')) {
    const files = configPaths(explicitConfig).filter(existsSync)
    for (const result of updateConfigs(files, undefined)) {
      console.log(`Config: ${result.file}${result.backup ? `\nBackup: ${result.backup}` : ''}`)
    }
  }
  if (existsSync(wrapper)) {
    if (!readFileSync(wrapper, 'utf8').startsWith(marker)) throw new Error('This file was not installed by VibeTrace')
    unlinkSync(wrapper)
  }
  console.log('VibeTrace registration removed. Restart OpenCode to unload it. Data and installed runtime snapshots are preserved.')
} else if (command === 'status' || command === 'open' || command === 'stop') {
  console.log(`Source: ${root}\nPlugin link: ${existsSync(wrapper) ? wrapper : 'not installed'}\nRuntime directory: ${runtimeDir}`)
  if (existsSync(wrapper)) {
    const entry = readFileSync(wrapper, 'utf8')
    console.log(`Registered source: ${entry.match(/import plugin from "([^"]+)"/)?.[1] || 'unrecognized entry'}`)
  }
  const states = []
  for (const file of existsSync(runtimeDir) ? readdirSync(runtimeDir) : []) {
    if (!file.endsWith('.json')) continue
    const stateFile = resolve(runtimeDir, file)
    let candidateRoot = root
    try {
      const candidate = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (candidate.root !== root) {
        if (JSON.parse(readFileSync(resolve(candidate.root, '.vibetrace-install.json'), 'utf8')).package !== '@xiaokeyan/opencode-vibetrace') continue
        candidateRoot = candidate.root
      }
    } catch { continue }
    const state = await liveState(stateFile, candidateRoot)
    if (state) states.push(state)
  }
  for (const state of states) console.log(`Running: ${state.url} → OpenCode ${state.serverUrl} [${state.connectionMode || 'unknown'}] (parent ${state.parentPid})`)
  if (!states.length) console.log('No managed VibeTrace service running. Start OpenCode and open a project.')
  if (command === 'open') states.forEach(state => openBrowser(state.url))
  if (command === 'stop') {
    for (const state of states) process.kill(state.pid, 'SIGTERM')
    if (states.length) console.log(`Stopping ${states.length} managed VibeTrace service(s). OpenCode itself remains open.`)
  }
} else throw new Error('Usage: vibetrace setup [--config FILE] [--local] | configure [--background-model provider/model] [--skill-model provider/model] | doctor | install|uninstall|status|open|stop [--plugin-dir DIRECTORY]')
