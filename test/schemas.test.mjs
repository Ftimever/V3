import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import { providerOptions } from './fixtures/plugins.mjs'

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strictRequired: false })
const schemas = new Map()
for (const name of ['plugin-manifest', 'plugin-group', 'rpc-envelope']) {
  const schema = JSON.parse(await readFile(new URL(`../schemas/${name}.v1.json`, import.meta.url), 'utf8'))
  schemas.set(name, ajv.compile(schema))
}

test('manifest schema accepts fixtures and rejects unknown or invalid fields', () => {
  const validate = schemas.get('plugin-manifest')
  const manifest = providerOptions().manifest
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors))
  for (const modified of [
    { ...manifest, schemaVersion: 2 },
    { ...manifest, pluginId: 'invalid' },
    { ...manifest, version: '1.0.0' },
    { ...manifest, runtime: { kind: 'unknown', entry: './index.js' } },
    { ...manifest, runtime: { kind: 'in-process', entry: 'C:/outside.js' } },
    { ...manifest, permissions: [{ id: 'anything' }] },
    { ...manifest, webui: { cards: [{ id: 'unsafe', component: 'custom-script' }] } },
  ]) assert.equal(validate(modified), false)
})

test('group schema keeps npm metadata in member declarations, not plugin metadata', () => {
  const validate = schemas.get('plugin-group')
  const group = {
    schemaVersion: 1,
    groupId: 'test.group',
    displayName: 'Test group',
    version: '1.0.0',
    members: [{ pluginId: 'test.provider', packageName: '@easybot-test/provider', version: '^1.0.0', instanceId: 'provider' }],
    serviceBindings: { 'test.counter': { implementation: 'provider', allowOverride: false } },
  }
  assert.equal(validate(group), true, JSON.stringify(validate.errors))
  assert.equal(validate({ ...group, unexpected: true }), false)
})

test('RPC schema accepts all envelope variants', () => {
  const validate = schemas.get('rpc-envelope')
  const base = { protocol: 'easybot.rpc', version: 1 }
  for (const envelope of [
    { type: 'request', id: '1', method: 'counter.read', payload: {} },
    { type: 'response', id: '1', ok: true, payload: { count: 1 } },
    { type: 'response', id: '1', ok: false, error: { code: 'PERMISSION_DENIED', message: 'Denied' } },
    { type: 'notification', method: 'counter.changed', payload: { count: 1 } },
    { type: 'stream', id: '1', stream: 'open' },
    { type: 'stream', id: '1', stream: 'chunk', payload: 'chunk' },
    { type: 'stream', id: '1', stream: 'close' },
    { type: 'cancel', id: '1', reason: 'cancelled' },
    { type: 'hello', capabilities: { services: [], features: ['cancel'] } },
    { type: 'hello-ack', capabilities: {} },
  ]) assert.equal(validate({ ...base, ...envelope }), true, JSON.stringify(validate.errors))
})

test('RPC schema distinguishes failure, success and incomplete messages', () => {
  const validate = schemas.get('rpc-envelope')
  const base = { protocol: 'easybot.rpc', version: 1 }
  for (const envelope of [
    { type: 'request', id: '1' },
    { type: 'notification', method: 'x', id: '1' },
    { type: 'response', id: '1', ok: false },
    { type: 'response', id: '1', ok: true, error: { code: 'PERMISSION_DENIED', message: 'bad' } },
    { type: 'cancel' },
    { type: 'stream', id: '1' },
    { type: 'hello' },
    { type: 'response', id: '1', ok: false, error: { code: 'unknown', message: 'bad' } },
  ]) assert.equal(validate({ ...base, ...envelope }), false)
  assert.equal(validate({ ...base, version: 2, type: 'cancel', id: '1' }), false)
})
