import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { harness, plugin, logger } from './fixtures/loader.mjs'
import { StateStore } from '../packages/state/dist/index.js'
import { ConfigManager } from '../packages/config/dist/index.js'

const token = { id: 'example.remote', version: '1.0.0', methods: ['read', 'pid', 'fail'] }
const permission = { id: 'service:example.remote' }
const runtime = { kind: 'child-process', entry: './index.js', protocolVersion: 1 }

test('child provider is loaded outside host, methods are async and private methods are not exported', async context => {
  const logs = []
  const { directory, loader } = await harness(context, { logger: { ...logger, info(message, fields) { logs.push({ message, fields }) } } })
  const provider = await plugin(directory, 'remote', { manifest: { runtime, provides: { services: [token] } }, code: `export function apply(context) { console.log('worker-only-log'); context.services.provide(${JSON.stringify(token)}, { read: async () => 42, pid: async () => process.pid, fail: async () => { throw new Error('remote-failure') }, privateMethod: () => 99 }) }` })
  const consumer = await plugin(directory, 'consumer', { manifest: { requires: { services: { required: [{ id: token.id, version: '^1.0.0' }] } }, permissions: [permission] }, code: `export async function apply(context) { const service = context.services.require(${JSON.stringify(token)}); context.logger.info('result', { value: await service.read(), pid: await service.pid(), privateMethod: typeof service.privateMethod }); try { await service.fail() } catch (error) { context.logger.info('error', { code: error.code, message: error.message }) } }` })
  await loader.discover(provider)
  await loader.discover({ ...consumer, policy: [permission], grants: [{ ...permission, instanceId: 'consumer' }] })
  await loader.startAll()
  const result = logs.find(record => record.message === 'result').fields
  assert.equal(result.value, 42)
  assert.notEqual(result.pid, process.pid)
  assert.equal(result.privateMethod, 'undefined')
  assert.equal(logs.find(record => record.message === 'error').fields.code, 'INTERNAL_ERROR')
  assert.ok(logs.some(record => record.message === 'child.stderr' && record.fields.text.includes('worker-only-log')))
  await loader.stopAll()
  assert.throws(() => process.kill(result.pid, 0))
})

test('child consumer calls host services with host-enforced permissions', async context => {
  const logs = []
  const { directory, loader } = await harness(context, { logger: { ...logger, info(message, fields) { logs.push({ message, fields }) } } })
  await loader.discover(await plugin(directory, 'provider', { manifest: { provides: { services: [token] } }, code: `export function apply(context) { context.services.provide(${JSON.stringify(token)}, { read: async () => 7 }) }` }))
  const consumer = await plugin(directory, 'consumer', { manifest: { runtime, requires: { services: { required: [{ id: token.id, version: '^1.0.0' }] } }, permissions: [permission] }, code: `export async function apply(context) { const value = await context.services.require(${JSON.stringify(token)}).read(); context.logger.info('host-value', { value }) }` })
  await loader.discover({ ...consumer, policy: [permission], grants: [{ ...permission, instanceId: 'consumer' }] })
  await loader.startAll()
  assert.ok(logs.some(record => record.message === 'child.stderr' && record.fields.text.includes('"value":7')))
  assert.equal(loader.status('consumer').state, 'running')
})

test('child event middleware participates in the host pipeline and is revoked on stop', async context => {
  const logs = []
  const { directory, loader } = await harness(context, { logger: { ...logger, info(message, fields) { logs.push({ message, fields }) } } })
  const event = { id: 'example.tick', version: '1.0.0', delivery: 'pipeline' }
  const intercept = { id: 'event:intercept.example.tick' }
  const publish = { id: 'event:publish.example.tick' }
  const middleware = await plugin(directory, 'middleware', { manifest: { runtime, permissions: [intercept] }, code: `export function apply(context) { context.events.use(${JSON.stringify(event)}, 'double', value => ({ action: 'continue', value: value * 2 })) }` })
  await loader.discover({ ...middleware, policy: [intercept], grants: [{ ...intercept, instanceId: 'middleware' }] })
  const emitter = await plugin(directory, 'emitter', { manifest: { provides: { events: [event] }, requires: { plugins: { required: [{ pluginId: 'example.middleware', version: '^1.0.0' }] } }, permissions: [publish] }, code: `export async function apply(context) { context.logger.info('pipeline', await context.events.emit(${JSON.stringify(event)}, 3)) }` })
  await loader.discover({ ...emitter, policy: [publish], grants: [{ ...publish, instanceId: 'emitter' }] })
  await loader.startAll()
  assert.equal(logs.find(record => record.message === 'pipeline').fields.value, 6)
  await loader.stopAll()
})

test('hung child startup has a bounded timeout and no in-process fallback', async context => {
  const { directory, loader } = await harness(context, { processStartupTimeoutMs: 300, processShutdownTimeoutMs: 50 })
  await loader.discover(await plugin(directory, 'hung', { manifest: { runtime }, code: 'export async function apply() { await new Promise(() => {}) }' }))
  await assert.rejects(loader.start('hung'))
  assert.equal(loader.status('hung').state, 'failed')
  assert.match(loader.status('hung').error, /runtime.start|handshake timeout/)
})

test('unexpected child exit stops consumers, automatically retries and quarantines within configured bound', async context => {
  const { directory, loader } = await harness(context, { processShutdownTimeoutMs: 30 })
  await loader.discover(await plugin(directory, 'crash', { manifest: { runtime, lifecycle: { restart: { enabled: true, maxAttempts: 1, delayMs: 0 } } }, code: 'export function apply() { setTimeout(() => process.exit(9), 40) }' }))
  await loader.startAll()
  for (let attempt = 0; attempt < 100 && loader.status('crash').state !== 'quarantined'; attempt += 1) { await delay(20); await loader.idle() }
  assert.equal(loader.status('crash').state, 'quarantined')
  assert.equal(loader.status('crash').restartAttempts, 1)
})

test('loader reconfiguration integrates hot hooks and dependency-aware restart rollback with config persistence', async context => {
  const logs = []
  const { directory, loader } = await harness(context, { logger: { ...logger, info(message, fields) { logs.push({ message, fields }) } } })
  const schema = { type: 'object', required: ['value'], properties: { value: { type: 'integer' } }, additionalProperties: false }
  await loader.discover({ ...await plugin(directory, 'configured', { manifest: { config: { schema: './config.json' } }, files: { 'config.json': schema }, code: "export function apply(context, config) { context.logger.info('apply', config); if (config.value === 9) throw new Error('bad-value') } export function reconfigure(context, next) { context.logger.info('hot', next) }" }), config: { value: 1 } })
  await loader.startAll()
  const store = new StateStore(':memory:')
  try {
    const manager = new ConfigManager(store)
    let snapshot = manager.register('configured', { schema, initial: { value: 1 }, reload: { value: 'hot' }, apply: (next, _previous, policy) => loader.reconfigure('configured', next, policy) })
    snapshot = await manager.save('configured', { value: 2 }, snapshot.revision)
    await manager.apply('configured', snapshot.revision)
    assert.ok(logs.some(record => record.message === 'hot' && record.fields.value === 2))
    const restart = new ConfigManager(store)
    snapshot = restart.register('configured', { schema, apply: (next, _previous, policy) => loader.reconfigure('configured', next, policy) })
    snapshot = await restart.save('configured', { value: 9 }, snapshot.revision)
    await assert.rejects(restart.apply('configured', snapshot.revision))
    assert.equal(restart.get('configured').state, 'apply-failed')
    assert.equal(loader.status('configured').state, 'running')
    assert.equal(logs.filter(record => record.message === 'apply').at(-1).fields.value, 2)
  } finally { store.close() }
})
