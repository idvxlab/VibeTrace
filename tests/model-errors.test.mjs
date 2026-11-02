import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import ts from 'typescript'
import { workerModelEnvironment, writeModelConfig, readModelConfig } from '../plugins/model-config.mjs'

const source = readFileSync(new URL('../src/utils/opencodeErrors.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { openCodeErrorMessage, sessionFailureFromEvent, latestMessageError, sessionRetryFromEvent, sessionRetryMessage } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const message = 'This version of OpenCode Desktop no longer supports free models. Update to the latest version at https://opencode.ai/download to keep using them.'
const failure = { name: 'APIError', data: { message, isRetryable: false } }

test('provider message survives nested API responses without exposing headers', () => {
  assert.equal(openCodeErrorMessage(failure), message)
  assert.equal(openCodeErrorMessage(JSON.stringify({ error: failure })), message)
  assert.equal(openCodeErrorMessage({ name: 'APIError', data: { responseBody: JSON.stringify({ error: { message } }), headers: { authorization: 'secret' } } }), message)
  assert.equal(openCodeErrorMessage({ name: 'MessageAbortedError' }), null)
})

test('SSE failures belong to their own session, including background sessions', () => {
  for (const envelope of [
    { payload: { type: 'session.error', properties: { sessionID: 'chat', error: failure } } },
    { type: 'session.error', data: { sessionID: 'chat', error: failure } },
    { type: 'message.updated', properties: { info: { sessionID: 'chat', error: failure } } },
  ]) assert.deepEqual(sessionFailureFromEvent(envelope), { sessionID: 'chat', message })
  assert.deepEqual(sessionFailureFromEvent({ type: 'session.error', properties: { sessionID: 'internal', error: failure } }), { sessionID: 'internal', message })
  assert.equal(sessionFailureFromEvent({ type: 'session.error', properties: { error: failure } }), null)
})

test('reloading an error-bearing assistant preserves its message; a new turn clears it', () => {
  const failed = { info: { role: 'assistant', error: failure }, parts: [] }
  assert.equal(latestMessageError([failed]), message)
  assert.equal(latestMessageError([failed, { info: { role: 'user' }, parts: [] }]), null)
  assert.equal(latestMessageError([failed, { info: { role: 'assistant' }, parts: [] }]), null)
})

test('saved background models reach desktop workers without changing chat selection', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'vibetrace-models-'))
  const file = resolve(dir, 'config.json')
  writeModelConfig(file, { backgroundModel: 'provider/analysis', skillEvolutionModel: 'provider/skills' })
  assert.deepEqual(workerModelEnvironment(dir, {}, {}), { MW_OPENCODE_MODEL: 'provider/analysis', MW_SKILL_EVOLVE_MODEL: 'provider/skills' })
  assert.equal(workerModelEnvironment(dir, { backgroundModel: 'provider/option' }, { MW_OPENCODE_MODEL: 'provider/env' }).MW_OPENCODE_MODEL, 'provider/option')
  assert.equal(workerModelEnvironment(dir, {}, { MW_OPENCODE_MODEL: 'provider/env' }).MW_OPENCODE_MODEL, 'provider/env')
  assert.throws(() => writeModelConfig(file, { backgroundModel: 'invalid' }), /providerID/)
  assert.equal(readModelConfig(file).backgroundModel, 'provider/analysis')
})

test('session retry preserves live status and calculates the countdown from next', () => {
  const retry = { message: 'Free usage exceeded, subscribe to Go', attempt: 1, next: 1730000000000 }
  for (const event of [
    { type: 'session.status', properties: { sessionID: 'chat', status: { type: 'retry', ...retry } } },
    { payload: { type: 'session.status', data: { sessionID: 'chat', status: { type: 'retry', ...retry } } } },
  ]) {
    assert.deepEqual(sessionRetryFromEvent(event), { sessionID: 'chat', retry })
    assert.equal(sessionFailureFromEvent(event), null)
  }
  assert.equal(sessionRetryMessage(retry, retry.next - 11542000), retry.message + '\nRetrying in 11542s - attempt 1')
  assert.equal(sessionRetryMessage(retry, retry.next + 1000), retry.message + '\nRetrying in 0s - attempt 1')
  for (const type of ['busy', 'idle']) {
    assert.deepEqual(sessionRetryFromEvent({ type: 'session.status', properties: { sessionID: 'internal', status: { type } } }), { sessionID: 'internal', retry: null })
  }
  assert.equal(sessionRetryFromEvent({ type: 'session.status', properties: { status: { type: 'retry', ...retry } } }), null)
  assert.equal(sessionRetryFromEvent({ type: 'session.status', properties: { sessionID: 'chat', status: { type: 'retry', message: retry.message } } }), null)
})
