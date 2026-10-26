#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root, runtimeDir, pythonExecutable, nodeExecutable, liveState, openBrowser } from '../plugins/launcher.mjs'

const command = process.argv[2] || 'status'
const targetIndex = process.argv.indexOf('--plugin-dir')
const pluginDir = targetIndex >= 0 ? resolve(process.argv[targetIndex + 1]) : resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'), 'opencode/plugins')
const wrapper = resolve(pluginDir, 'vibetrace.js')
const marker = '// Managed by VibeTrace local installer\n'
if (command === 'install') {
  const runtimes = { python: pythonExecutable(), node: nodeExecutable() }
  if (!existsSync(resolve(root, 'dist/.vibetrace-plugin-build'))) throw new Error('First run npm run build:plugin')
  if (existsSync(wrapper) && !readFileSync(wrapper, 'utf8').startsWith(marker)) throw new Error(`Refusing to overwrite unrelated file: ${wrapper}`)
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(wrapper, marker + `import plugin from ${JSON.stringify(pathToFileURL(resolve(root, 'plugins/vibetrace.mjs')).href)};\nexport default { id: plugin.id, server: ctx => plugin.server(ctx, ${JSON.stringify(runtimes)}) };\n`)
  console.log(`Installed local link: ${wrapper}\nSource: ${root}\nRestart OpenCode and open a project. Keep this source directory in place.`)
} else if (command === 'uninstall') {
  if (existsSync(wrapper)) {
    if (!readFileSync(wrapper, 'utf8').startsWith(marker)) throw new Error('This file was not installed by VibeTrace')
    unlinkSync(wrapper)
  }
  console.log('Local plugin link removed. Restart OpenCode to unload it. Data is preserved.')
} else if (command === 'status' || command === 'open' || command === 'stop') {
  console.log(`Source: ${root}\nPlugin link: ${existsSync(wrapper) ? wrapper : 'not installed'}\nRuntime directory: ${runtimeDir}`)
  if (existsSync(wrapper)) {
    const entry = readFileSync(wrapper, 'utf8')
    console.log(`Registered source: ${entry.match(/import plugin from "([^"]+)"/)?.[1] || 'unrecognized entry'}`)
  }
  const states = []
  for (const file of existsSync(runtimeDir) ? readdirSync(runtimeDir) : []) {
    if (!file.endsWith('.json')) continue
    const state = await liveState(resolve(runtimeDir, file))
    if (state) states.push(state)
  }
  for (const state of states) console.log(`Running: ${state.url} → OpenCode ${state.serverUrl} [${state.connectionMode || 'unknown'}] (parent ${state.parentPid})`)
  if (!states.length) console.log('No managed VibeTrace service running. Start OpenCode and open a project.')
  if (command === 'open') states.forEach(state => openBrowser(state.url))
  if (command === 'stop') {
    for (const state of states) process.kill(state.pid, 'SIGTERM')
    if (states.length) console.log(`Stopping ${states.length} managed VibeTrace service(s). OpenCode itself remains open.`)
  }
} else throw new Error('Usage: node scripts/vibetrace.mjs install|uninstall|status|open|stop [--plugin-dir DIRECTORY]')
