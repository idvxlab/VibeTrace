import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import jsonc from 'jsonc-parser'
import { configPath, configPaths, editConfig, updateConfig, updateConfigs, packageName } from '../scripts/config.mjs'
import { needsSdkBridge } from '../plugins/v1-context.mjs'

test('plugin module has exactly one callable export for the old V1 loader', async () => {
  const mod = await import('../plugins/vibetrace.mjs')
  assert.deepEqual(Object.keys(mod), ['default'])
  assert.equal(typeof mod.default, 'function')
  assert.equal(needsSdkBridge(undefined), true)
  assert.equal(needsSdkBridge('http://localhost:4096'), true)
  assert.equal(needsSdkBridge('http://127.0.0.1:1234'), false)
})

test('JSONC registration preserves comments, other plugins and model settings', () => {
  const before = '{\n // model preference\n "model": "test/model",\n "plugin": [\n // another plugin\n "other@1",\n ],\n}\n'
  const after = editConfig(before, packageName + '@1.0.1')
  assert.match(after, /model preference/)
  assert.match(after, /another plugin/)
  assert.deepEqual(jsonc.parse(after), { model: 'test/model', plugin: ['other@1', packageName + '@1.0.1'] })
  assert.equal(editConfig(after, packageName + '@1.0.1'), after)
})

test('upgrade deduplicates package references and preserves plugin options', () => {
  const result = jsonc.parse(editConfig(JSON.stringify({ plugin: [[packageName + '@1.0.0', { python: '/custom/python' }], 'other', packageName] }), packageName + '@1.0.1'))
  assert.deepEqual(result.plugin, [[packageName + '@1.0.1', { python: '/custom/python' }], 'other'])
  assert.deepEqual(jsonc.parse(editConfig(JSON.stringify(result), undefined)).plugin, ['other'])
})

test('malformed, ambiguous, or wrong-shaped configuration is rejected', () => {
  for (const text of ['{', '[]', '{"plugin": "other"}', '{"plugin":[],"plugin":[]}']) assert.throws(() => editConfig(text, packageName))
})

test('atomic config edits keep backup, preserve invalid originals and respect locks', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'vibetrace-config-'))
  const file = resolve(dir, 'config with spaces.jsonc')
  writeFileSync(file, '{ // existing\n "model": "test"\n}\n')
  const before = readFileSync(file, 'utf8')
  const result = updateConfig(file, packageName)
  assert.equal(readFileSync(result.backup, 'utf8'), before)
  assert.equal(updateConfig(file, packageName).changed, false)
  writeFileSync(file + '.vibetrace-lock', '')
  assert.throws(() => updateConfig(file, undefined))
  assert.deepEqual(jsonc.parse(readFileSync(file, 'utf8')).plugin, [packageName])
  const invalid = resolve(dir, 'invalid.json')
  writeFileSync(invalid, '{broken')
  assert.throws(() => updateConfig(invalid, packageName))
  assert.equal(readFileSync(invalid, 'utf8'), '{broken')
  assert.equal(existsSync(invalid + '.vibetrace-lock'), false)
})

test('config discovery follows OpenCode global precedence and supports overrides', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'vibetrace-discovery-'))
  const config = resolve(dir, 'opencode')
  mkdirSync(config)
  assert.equal(configPath(undefined, { XDG_CONFIG_HOME: dir }, dir), resolve(dir, '.config', 'opencode', 'opencode.json'))
  writeFileSync(resolve(config, 'opencode.jsonc'), '{}')
  assert.equal(configPath(undefined, { XDG_CONFIG_HOME: dir }), resolve(config, 'opencode.jsonc'))
  writeFileSync(resolve(config, 'opencode.json'), '{}')
  assert.equal(configPath(undefined, { XDG_CONFIG_HOME: dir }), resolve(config, 'opencode.jsonc'))
  writeFileSync(resolve(dir, 'custom.json'), '{}')
  assert.equal(configPath(undefined, { OPENCODE_CONFIG: resolve(dir, 'custom.json') }), resolve(dir, 'custom.json'))
})

test('symbolic links are not replaced', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'vibetrace-link-'))
  writeFileSync(resolve(dir, 'original'), '{}')
  symlinkSync(resolve(dir, 'original'), resolve(dir, 'config.json'))
  assert.throws(() => updateConfig(resolve(dir, 'config.json'), packageName), /linked/)
  assert.equal(readFileSync(resolve(dir, 'original'), 'utf8'), '{}')
})


test('literal home placeholders expand for all config path inputs', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'vibetrace-home-'))
  const dir = resolve(home, '.config', 'opencode')
  mkdirSync(dir, { recursive: true })
  const file = resolve(dir, 'opencode.json')
  writeFileSync(file, '{}')
  assert.equal(configPath(undefined, {}, home), file)
  for (const prefix of ['~', '$HOME', '${HOME}', '%USERPROFILE%']) {
    const value = `${prefix}/.config/opencode/opencode.json`
    assert.equal(configPath(value, {}, home), file)
    assert.equal(configPath(undefined, { OPENCODE_CONFIG: value }, home), file)
    assert.equal(configPath(undefined, { OPENCODE_CONFIG_DIR: `${prefix}/.config/opencode` }, home), file)
    assert.equal(configPath(undefined, { XDG_CONFIG_HOME: `${prefix}/.config` }, home), file)
  }
  assert.equal(configPath('%USERPROFILE%/.config/opencode/opencode.json', { USERPROFILE: home }, '/unused'), file)
  if (process.platform === 'win32') {
    assert.equal(configPath('%USERPROFILE%\\.config\\opencode\\opencode.json', { USERPROFILE: home }, home), file)
  }
})

test('missing override falls back to existing default and only creates at default', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'vibetrace-fallback-'))
  const file = resolve(home, '.config', 'opencode', 'opencode.json')
  const elsewhere = resolve(home, 'elsewhere')
  assert.equal(configPath(undefined, {}, home), file)
  assert.equal(configPath(resolve(elsewhere, 'custom.json'), {}, home), file)
  assert.equal(configPath(undefined, { OPENCODE_CONFIG_DIR: elsewhere }, home), file)
  updateConfig(file, packageName)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { plugin: [packageName] })
  writeFileSync(file, JSON.stringify({ model: 'test/model', autoupdate: false }))
  const selected = configPath(undefined, { XDG_CONFIG_HOME: elsewhere }, home)
  assert.equal(selected, file)
  updateConfig(selected, packageName)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { model: 'test/model', autoupdate: false, plugin: [packageName] })
  assert.equal(existsSync(elsewhere), false)
})

test('unresolved and relative paths fail before creating directories', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'vibetrace-invalid-'))
  for (const value of ['$UNKNOWN/config', '%UNKNOWN%/config', '~someone/config', 'relative/config', `${home}/$BAD/config`, `${home}/bad%/config`]) {
    for (const env of [{ OPENCODE_CONFIG: value }, { OPENCODE_CONFIG_DIR: value }, { XDG_CONFIG_HOME: value }]) {
      assert.throws(() => configPath(undefined, env, home), /Invalid OpenCode config path/)
    }
    assert.throws(() => configPath(value, {}, home), /Invalid OpenCode config path/)
  }
  assert.equal(existsSync(resolve(home, '.config')), false)
  assert.equal(existsSync(resolve(home, '$BAD')), false)
})


test('coexisting global configs select the effective source without changing other files', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'vibetrace-precedence-'))
  const dir = resolve(home, '.config', 'opencode')
  mkdirSync(dir, { recursive: true })
  for (const name of ['config.json', 'opencode.json', 'opencode.jsonc']) {
    writeFileSync(resolve(dir, name), JSON.stringify({ model: name, plugin: ['other-plugin'] }))
    assert.equal(configPath(undefined, {}, home), resolve(dir, name))
  }
  const jsonBefore = readFileSync(resolve(dir, 'opencode.json'), 'utf8')
  const legacyBefore = readFileSync(resolve(dir, 'config.json'), 'utf8')
  const file = configPath(undefined, {}, home)
  updateConfig(file, packageName)
  assert.deepEqual(jsonc.parse(readFileSync(file, 'utf8')), { model: 'opencode.jsonc', plugin: ['other-plugin', packageName] })
  assert.equal(readFileSync(resolve(dir, 'opencode.json'), 'utf8'), jsonBefore)
  assert.equal(readFileSync(resolve(dir, 'config.json'), 'utf8'), legacyBefore)
  assert.equal(configPath(resolve(dir, 'opencode.json'), {}, home), resolve(dir, 'opencode.json'))
  assert.equal(configPath(undefined, { OPENCODE_CONFIG: resolve(dir, 'opencode.json') }, home), resolve(dir, 'opencode.json'))
  assert.equal(configPath(undefined, { OPENCODE_CONFIG_DIR: dir }, home), file)
  assert.equal(configPath(undefined, { OPENCODE_CONFIG_DIR: resolve(home, 'missing') }, home), file)
})


test('mirrored install, upgrade and uninstall preserve all sibling settings', () => {
  const home = mkdtempSync(resolve(tmpdir(), 'vibetrace-mirror-'))
  const initial = configPaths(undefined, {}, home)
  assert.deepEqual(initial, [resolve(home, '.config', 'opencode', 'opencode.json')])
  updateConfigs(initial, packageName + '@1.0.1')
  const dir = resolve(home, '.config', 'opencode')
  writeFileSync(resolve(dir, 'opencode.jsonc'), '{ // keep permission\n "permission": "ask", "plugin": ["other"] }')
  writeFileSync(resolve(dir, 'config.json'), '{"autoupdate":false}')
  const files = configPaths(undefined, {}, home)
  assert.equal(files.length, 3)
  const spec = 'file:///shared/vibetrace/plugins/vibetrace.mjs'
  updateConfigs(files, packageName + '@1.0.2')
  for (const file of files) {
    const value = jsonc.parse(readFileSync(file, 'utf8'))
    assert.equal(value.plugin.filter(x => x === packageName + '@1.0.2').length, 1)
    assert.equal(value.plugin.includes(packageName + '@1.0.1'), false)
  }
  assert.equal(updateConfigs(files, packageName + '@1.0.2').every(x => !x.changed), true)
  updateConfigs(files, undefined)
  assert.deepEqual(jsonc.parse(readFileSync(files[0], 'utf8')), {permission:'ask', plugin:['other']})
  assert.match(readFileSync(files[0], 'utf8'), /keep permission/)
  assert.equal(jsonc.parse(readFileSync(resolve(dir, 'config.json'), 'utf8')).autoupdate, false)
  for (const file of files) assert.equal(jsonc.parse(readFileSync(file, 'utf8')).plugin?.some(x => x.startsWith(packageName)), false)
  writeFileSync(files[2], '{broken')
  const before = readFileSync(files[0], 'utf8')
  assert.throws(() => updateConfigs(files, spec), /Invalid JSON/)
  assert.equal(readFileSync(files[0], 'utf8'), before)
})
