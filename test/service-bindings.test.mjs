import assert from 'node:assert/strict'
import { test } from 'node:test'
import { harness, plugin, service, permission, logger } from './fixtures/loader.mjs'

test('explicit binding selects replacement without global monkey patching or fallback', async context => {
  const values = []
  const { directory, loader } = await harness(context, { serviceBindings: { [service.id]: 'replacement' }, logger: { ...logger, info(message, fields) { if (message === 'selected') values.push(fields.value) } } })
  for (const [id, value] of [['original', 1], ['replacement', 2]]) await loader.discover(await plugin(directory, id, { manifest: { provides: { services: [service] } }, code: `export function apply(context) { context.services.provide(${JSON.stringify(service)}, { read: () => ${value} }) }` }))
  const consumer = await plugin(directory, 'consumer', { manifest: { requires: { services: { required: [{ id: service.id, version: '^1.0.0' }] } }, permissions: [permission] }, code: `export function apply(context) { context.logger.info('selected', { value: context.services.require(${JSON.stringify(service)}).read() }) }` })
  await loader.discover({ ...consumer, policy: [permission], grants: [{ ...permission, instanceId: 'consumer' }] })
  await loader.startAll()
  assert.deepEqual(values, [2])
  await loader.stop('original')
  assert.equal(loader.status('consumer').state, 'running')
  await loader.stop('replacement')
  assert.equal(loader.status('consumer').state, 'stopped')
})

test('requester-scoped providers bind identities to consumer context and revoke access on stop', async context => {
  const values = []
  const { directory, loader } = await harness(context, { logger: { ...logger, info(message, fields) { if (message === 'identity') values.push(fields.id) } } })
  await loader.discover(await plugin(directory, 'provider', { manifest: { provides: { services: [service] } }, code: `export function apply(context) { context.services.provideScoped(${JSON.stringify(service)}, requester => ({ identity: () => { requester.lifecycle.assertActive(); return requester.plugin.instanceId } })) }` }))
  for (const id of ['consumer-one', 'consumer-two']) {
    const consumer = await plugin(directory, id, { manifest: { requires: { services: { required: [{ id: service.id, version: '^1.0.0' }] } }, permissions: [permission] }, code: `export function apply(context) { context.logger.info('identity', { id: context.services.require(${JSON.stringify(service)}).identity() }) }` })
    await loader.discover({ ...consumer, policy: [permission], grants: [{ ...permission, instanceId: id }] })
  }
  await loader.startAll()
  assert.deepEqual(values.sort(), ['consumer-one', 'consumer-two'])
})
