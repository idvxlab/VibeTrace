import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { configPaths, editConfig, packageName, updateConfigs } from './config.mjs'
import { root, pythonExecutable, nodeExecutable } from '../plugins/launcher.mjs'

export function doctor() {
  const result = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 10000, shell: process.platform === 'win32', windowsHide: true })
  const cliVersion = result.stdout?.replace(/\x1b\[[0-9;]*m/g, '').match(/\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)/)?.[1]
  const supportedV1 = (version) => version?.startsWith('1.') && Number(version.split('.')[1]) >= 2
  let version = supportedV1(cliVersion) ? cliVersion : undefined
  let host = 'CLI'
  if (!version && process.platform === 'darwin') {
    const plist = resolve(process.env.OPENCODE_DESKTOP_APP || '/Applications/OpenCode.app', 'Contents/Info.plist')
    if (existsSync(plist)) {
      const desktop = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { encoding: 'utf8', timeout: 10000 })
      const desktopVersion = desktop.status === 0 ? desktop.stdout.trim() : undefined
      if (supportedV1(desktopVersion)) { version = desktopVersion; host = 'Desktop' }
    }
  }
  if (!version) throw new Error('This package requires OpenCode V1.2+ CLI or a supported macOS OpenCode V1 Desktop app. OpenCode 2 uses @xiaokeyan/opencode-v2-vibetrace.')
  return { version, host, node: nodeExecutable(), python: pythonExecutable() }
}

export function setup(explicit) {
  const env = doctor()
  if (!existsSync(resolve(root, 'dist/.vibetrace-plugin-build'))) throw new Error('Built dashboard missing. In a checkout run npm run build:plugin first.')
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  if (pkg.name !== packageName || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error('Unexpected VibeTrace package identity')
  const files = configPaths(explicit)
  const file = files[0]
  const target = resolve(dirname(file), 'vibetrace', 'packages', pkg.version)
  // Early V1 cannot parse scoped npm names. Use an explicit file URL on every
  // V1 host. Copy runtime files out of npx's disposable cache first.
  const spec = pathToFileURL(resolve(target, 'plugins/vibetrace.mjs')).href
  // Validate before copying any runtime files or touching existing config.
  for (const file of files) editConfig(existsSync(file) ? readFileSync(file, 'utf8') : '{}\n', spec)
  if (!existsSync(target)) {
    const staging = target + '.tmp-' + randomUUID()
    mkdirSync(staging, { recursive: true })
    try {
      for (const name of ['plugins', 'dist', 'memory_worker']) cpSync(resolve(root, name), resolve(staging, name), { recursive: true })
      writeFileSync(resolve(staging, 'package.json'), JSON.stringify({ name: packageName, version: pkg.version, type: 'module' }))
      writeFileSync(resolve(staging, '.vibetrace-install.json'), JSON.stringify({ package: packageName, version: pkg.version }))
      renameSync(staging, target)
    } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }) }
  } else if (JSON.parse(readFileSync(resolve(target, '.vibetrace-install.json'), 'utf8')).package !== packageName) {
    throw new Error(`Refusing to reuse an unrelated directory: ${target}`)
  }
  const results = updateConfigs(files, spec)
  console.log(`OpenCode ${env.version}; Node: ${env.node}; Python: ${env.python}`)
  for (const result of results) {
    console.log(`Config ${result.changed ? 'updated' : 'already configured'}: ${result.file}`)
    if (result.backup) console.log(`Backup: ${result.backup}`)
  }
  console.log(`Installed runtime: ${target}\nRestart OpenCode to load VibeTrace. Registration is complete; runtime health has not yet been checked.`)
}
