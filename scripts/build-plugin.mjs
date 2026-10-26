import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const env = { ...process.env, VIBETRACE_BUILD_PLUGIN: '1', VITE_OPENCODE_BASE: '', VITE_MEMORY_WORKER_BASE: '', VITE_OPENCODE_SERVER_PASSWORD: '', VITE_OPENCODE_SERVER_USERNAME: '' }
for (const args of [
  ['exec', 'tsc', '--', '-p', 'tsconfig.app.json', '--noEmit'],
  ['exec', 'tsc', '--', '-p', 'tsconfig.node.json', '--noEmit'],
  ['exec', 'vite', '--', 'build'],
]) {
  const result = spawnSync(npm, args, { stdio: 'inherit', shell: process.platform === 'win32', env })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
writeFileSync('dist/.vibetrace-plugin-build', 'same-origin-v1\n')
