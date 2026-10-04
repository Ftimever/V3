import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { StateStore, SecretVault } from '../packages/state/dist/index.js'
import { ConfigManager } from '../packages/config/dist/index.js'

test('durable state uses CAS across connections and rejects non-JSON values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easybot-state-'))
  const path = join(directory, 'state.sqlite')
  const first = new StateStore(path)
  const second = new StateStore(path)
  try {
    first.put('one', 'key', { value: 1 }, 0)
    assert.equal(second.get('one', 'key').revision, 1)
    assert.throws(() => second.put('one', 'key', { value: 2 }, 0), { code: 'VERSION_MISMATCH' })
    second.put('one', 'key', { value: 2 }, 1)
    assert.equal(first.get('one', 'key').value.value, 2)
    assert.equal(first.get('two', 'key'), undefined)
    for (const value of [NaN, { value: undefined }, new Date(), { value: Infinity }]) assert.throws(() => first.put('one', 'bad', value, 0))
    assert.throws(() => first.delete('one', 'key', 1), { code: 'VERSION_MISMATCH' })
  } finally {
    first.close()
    second.close()
  }
  const reopened = new StateStore(path)
  assert.equal(reopened.get('one', 'key').value.value, 2)
  reopened.close()
  await rm(directory, { recursive: true, force: true })
})

test('secret vault persists only authenticated ciphertext', () => {
  const store = new StateStore(':memory:')
  try {
    const key = randomBytes(32)
    const vault = new SecretVault(store, key)
    vault.set('plugin/key', 'very-secret-value')
    assert.equal(vault.get('plugin/key'), 'very-secret-value')
    assert.ok(!JSON.stringify(store.get('secrets', 'plugin/key')).includes('very-secret-value'))
    assert.throws(() => new SecretVault(store, randomBytes(32)).get('plugin/key'))
    const record = store.get('secrets', 'plugin/key')
    store.put('secrets', 'other/key', record.value, 0)
    assert.throws(() => vault.get('other/key'))
    vault.delete('plugin/key')
    assert.equal(vault.get('plugin/key'), undefined)
  } finally { store.close() }
})

const schema = { type: 'object', additionalProperties: false, properties: { value: { type: 'integer' }, manual: { type: 'boolean' } }, required: ['value'] }

test('config has immutable snapshots, schema validation, CAS, separate saved/running versions and manual confirmation', async () => {
  const store = new StateStore(':memory:')
  const manager = new ConfigManager(store)
  const calls = []
  try {
    let current = manager.register('one', { schema, initial: { value: 1 }, reload: { value: 'hot', manual: 'manual' }, apply: async (next, previous, policy) => { calls.push({ next, previous, policy }) } })
    assert.ok(Object.isFrozen(current.running))
    await assert.rejects(manager.save('one', { value: 'bad' }, current.revision), { code: 'INVALID_CONFIG' })
    const original = current
    current = await manager.save('one', { value: 2 }, current.revision)
    assert.equal(current.running.value, 1)
    await assert.rejects(manager.save('one', { value: 3 }, original.revision), { code: 'VERSION_MISMATCH' })
    current = await manager.apply('one', current.revision)
    assert.equal(current.running.value, 2)
    assert.equal(current.runningVersion, current.savedVersion)
    assert.equal(calls[0].policy, 'hot')
    current = await manager.save('one', { value: 3, manual: true }, current.revision)
    current = await manager.apply('one', current.revision)
    assert.equal(current.state, 'pending')
    assert.equal(calls.length, 1)
    current = await manager.apply('one', current.revision, true)
    assert.equal(current.state, 'applied')
    assert.equal(calls[1].policy, 'restart')
  } finally { store.close() }
})

test('config apply failure restores previous runtime and preserves saved configuration', async () => {
  const store = new StateStore(':memory:')
  const manager = new ConfigManager(store)
  let runtime = 1
  try {
    let current = manager.register('one', { schema, initial: { value: 1 }, apply: async next => { runtime = next.value; if (runtime === 2) throw new Error('fail') } })
    current = await manager.save('one', { value: 2 }, current.revision)
    await assert.rejects(manager.apply('one', current.revision), { code: 'INVALID_CONFIG' })
    current = manager.get('one')
    assert.equal(runtime, 1)
    assert.equal(current.state, 'apply-failed')
    assert.equal(current.saved.value, 2)
    assert.equal(current.running.value, 1)
  } finally { store.close() }
})

test('config rollback failure remains visible and interrupted apply is reconciled on registration', async () => {
  const store = new StateStore(':memory:')
  const manager = new ConfigManager(store)
  try {
    let current = manager.register('one', { schema, initial: { value: 1 }, apply: async () => { throw new Error('unavailable') } })
    current = await manager.save('one', { value: 2 }, current.revision)
    await assert.rejects(manager.apply('one', current.revision))
    assert.equal(manager.get('one').state, 'rollback-failed')
    const stored = store.get('config', 'one')
    store.put('config', 'one', { ...stored.value, state: 'applying' }, stored.revision)
    const restarted = new ConfigManager(store)
    assert.equal(restarted.register('one', { schema, apply: async () => {} }).state, 'apply-failed')
  } finally { store.close() }
})
