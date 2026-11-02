import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, lstatSync, openSync, closeSync } from 'node:fs'
import { dirname, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import jsonc from 'jsonc-parser'

export const packageName = '@xiaokeyan/opencode-vibetrace'
// Expand shell placeholders here: callers may pass them literally on Windows.
function expandPath(value, env, home) {
  const expanded = value
    .replace(/^~(?=$|[\\/])/, () => home)
    .replace(/\$HOME\b|\$\{HOME\}/g, () => home)
    .replace(/%USERPROFILE%/gi, () => env.USERPROFILE || home)
  if (/[$%~]/.test(expanded) || !isAbsolute(expanded)) {
    throw new Error(`Invalid OpenCode config path (use an absolute path without unresolved variables): ${value}`)
  }
  return resolve(expanded)
}

function findConfig(dir) {
  // Global config loads config.json, then opencode.json, then opencode.jsonc
  // in V1.2.0, V1.18.16 and V1.19.5. Edit the last existing source so a
  // later global plugin array cannot hide this registration.
  return ['opencode.jsonc', 'opencode.json', 'config.json']
    .map(name => resolve(dir, name)).find(existsSync)
}

export function configPath(explicit, env = process.env, home = homedir()) {
  const defaultDir = resolve(home, '.config', 'opencode')
  const override = explicit || env.OPENCODE_CONFIG
  if (override) {
    const file = expandPath(override, env, home)
    if (existsSync(file)) return file
    return findConfig(dirname(file)) || findConfig(defaultDir) || resolve(defaultDir, 'opencode.json')
  }
  const dir = env.OPENCODE_CONFIG_DIR
    ? expandPath(env.OPENCODE_CONFIG_DIR, env, home)
    : env.XDG_CONFIG_HOME
      ? resolve(expandPath(env.XDG_CONFIG_HOME, env, home), 'opencode')
      : defaultDir
  return findConfig(dir) || (dir !== defaultDir && findConfig(defaultDir)) || resolve(defaultDir, 'opencode.json')
}

// Mirror registrations across existing sibling configs. Never create extra
// siblings; an explicit custom filename remains included in the selection.
export function configPaths(explicit, env = process.env, home = homedir()) {
  const selected = configPath(explicit, env, home)
  const siblings = ['opencode.jsonc', 'opencode.json', 'config.json']
    .map(name => resolve(dirname(selected), name)).filter(existsSync)
  return [...new Set([selected, ...siblings])]
}

export function updateConfigs(files, spec) {
  // Check every original before making the first edit, so an invalid sibling
  // cannot cause an ordinary partial install or uninstall.
  for (const file of files) {
    if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) {
      throw new Error(`Refusing to replace a linked or non-regular config: ${file}`)
    }
    if (existsSync(file + '.vibetrace-lock')) throw new Error(`Configuration is locked: ${file}`)
    editConfig(existsSync(file) ? readFileSync(file, 'utf8') : '{}\n', spec)
  }
  return files.map(file => updateConfig(file, spec))
}

export function isVibeTrace(entry) {
  const spec = Array.isArray(entry) ? entry[0] : entry
  if (typeof spec !== 'string') return false
  if ([packageName, 'opencode-vibetrace'].some(name => spec === name || spec.startsWith(name + '@'))) return true
  if (!spec.startsWith('file:')) return false
  try {
    const root = resolve(dirname(fileURLToPath(spec)), '..')
    return JSON.parse(readFileSync(resolve(root, '.vibetrace-install.json'), 'utf8')).package === packageName
  } catch { return false }
}

function parse(text) {
  const errors = []
  const value = jsonc.parse(text, errors, { allowTrailingComma: true, allowEmptyContent: false })
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON/JSONC configuration; original file was not changed')
  if (value.plugin !== undefined && !Array.isArray(value.plugin)) throw new Error('OpenCode plugin must be an array; original file was not changed')
  // Duplicate keys are ambiguous and may otherwise edit the wrong property.
  function check(node) {
    if (node.type === 'object') {
      const keys = node.children.map(p => p.children[0].value)
      if (new Set(keys).size !== keys.length) throw new Error('Duplicate JSON keys; original file was not changed')
    }
    for (const child of node.children || []) check(child)
  }
  check(jsonc.parseTree(text))
  return value
}

export function editConfig(text, spec) {
  const original = parse(text)
  let result = text
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' }
  const set = (path, value, extra = {}) => { result = jsonc.applyEdits(result, jsonc.modify(result, path, value, { formattingOptions, ...extra })) }
  let entries = original.plugin || []
  const matches = entries.flatMap((entry, i) => isVibeTrace(entry) ? [i] : [])
  // Remove backwards so indices and unrelated entries remain stable.
  for (const i of [...matches].reverse()) {
    if (spec && i === matches[0]) continue
    const array = jsonc.findNodeAtLocation(jsonc.parseTree(result), ['plugin'])
    const node = array.children[i]
    const scanner = jsonc.createScanner(result, true)
    scanner.setPosition(node.offset + node.length)
    let comma
    if (scanner.scan() === jsonc.SyntaxKind.CommaToken) comma = scanner.getTokenOffset()
    else if (i > 0) {
      const previous = array.children[i - 1]
      scanner.setPosition(previous.offset + previous.length)
      if (scanner.scan() === jsonc.SyntaxKind.CommaToken) comma = scanner.getTokenOffset()
    }
    result = jsonc.applyEdits(result, [
      { offset: node.offset, length: node.length, content: '' },
      ...(comma === undefined ? [] : [{ offset: comma, length: 1, content: '' }]),
    ])
  }
  if (spec) {
    if (!matches.length) {
      if (original.plugin === undefined) set(['plugin'], [spec])
      else set(['plugin', entries.length], spec, { isArrayInsertion: true })
    } else {
      const entry = entries[matches[0]]
      set(Array.isArray(entry) ? ['plugin', matches[0], 0] : ['plugin', matches[0]], spec)
    }
  }
  parse(result)
  return result
}

export function updateConfig(file, spec) {
  mkdirSync(dirname(file), { recursive: true })
  const lock = file + '.vibetrace-lock'
  const fd = openSync(lock, 'wx', 0o600)
  let temp
  try {
    if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error(`Refusing to replace a linked or non-regular config: ${file}`)
    const existed = existsSync(file)
    const before = existed ? readFileSync(file, 'utf8') : '{}\n'
    const after = editConfig(before, spec)
    if (after === before) return { file, changed: false }
    const backup = existed ? `${file}.vibetrace-${randomUUID()}.bak` : undefined
    if (backup) writeFileSync(backup, before, { flag: 'wx', mode: 0o600 })
    temp = `${file}.vibetrace-${randomUUID()}.tmp`
    writeFileSync(temp, after, { flag: 'wx', mode: existed ? lstatSync(file).mode & 0o777 : 0o600 })
    if (existsSync(file) !== existed || existed && readFileSync(file, 'utf8') !== before) throw new Error('Configuration changed during setup; retry after other editors have saved')
    renameSync(temp, file)
    temp = undefined
    return { file, backup, changed: true }
  } finally {
    if (temp && existsSync(temp)) unlinkSync(temp)
    closeSync(fd)
    unlinkSync(lock)
  }
}
