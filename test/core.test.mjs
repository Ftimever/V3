import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCoreRuntime, CoreError, LifecycleScope, defineService } from '../packages/core/dist/index.js'
import { counterToken, changeEvent, pluginOptions, providerOptions, consumerOptions } from './fixtures/plugins.mjs'

test('scope cleans in reverse order, exactly once, even after a disposer fails', async () => {
  const scope = new LifecycleScope()
  const order = []
  scope.add(() => order.push('first'))
  scope.add(() => { order.push('second'); throw new Error('cleanup failure') })
  scope.add(() => order.push('third'))
  const first = scope.dispose()
  assert.equal(scope.dispose(), first)
  await assert.rejects(first, AggregateError)
  assert.deepEqual(order, ['third', 'second', 'first'])
  assert.throws(() => scope.add(() => {}), { code: 'SCOPE_DISPOSED' })
})

test('individual disposal deregisters cleanup and remains idempotent', async () => {
  const scope = new LifecycleScope()
  let count = 0
  const dispose = scope.add(() => { count++ })
  await Promise.all([dispose(), dispose()])
  await scope.dispose()
  assert.equal(count, 1)
})

test('service token rejects invalid versions and is immutable', () => {
  assert.throws(() => defineService({ id: 'test.counter', version: 'latest' }))
  const token = defineService(counterToken)
  assert.equal(Object.isFrozen(token), true)
})

test('provider and consumer communicate through Cordis-backed scoped services', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  let registration
  const provider = await runtime.mount(providerOptions(), context => {
    registration = context.services.provide(counterToken, { count: () => 42 }, 'unavailable')
  })
  const consumer = await runtime.mount(consumerOptions(), () => {})
  assert.equal(consumer.context.services.readiness(counterToken), 'unavailable')
  assert.throws(() => consumer.context.services.require(counterToken), { code: 'SERVICE_NOT_READY' })
  registration.setReadiness('ready')
  assert.equal(consumer.context.services.require(counterToken).count(), 42)
  await provider.dispose()
  assert.equal(consumer.context.services.get(counterToken), undefined)
  assert.throws(() => consumer.context.services.require(counterToken), { code: 'SERVICE_NOT_FOUND' })
})

test('duplicate provider fails without removing the original service', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  await runtime.mount(providerOptions(), context => { context.services.provide(counterToken, { value: 1 }) })
  const duplicate = providerOptions()
  duplicate.identity.instanceId = 'duplicate'
  await assert.rejects(runtime.mount(duplicate, context => {
    context.services.provide(counterToken, { value: 2 })
  }), { code: 'SERVICE_CONFLICT' })
  const consumer = await runtime.mount(consumerOptions(), () => {})
  assert.equal(consumer.context.services.require(counterToken).value, 1)
})

test('activation failure releases registered resources and permits the same instance to retry', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  let cleaned = false
  await assert.rejects(runtime.mount(providerOptions(), context => {
    context.lifecycle.add(() => { cleaned = true })
    context.services.provide(counterToken, {})
    throw new Error('intentional failure')
  }), /intentional failure/)
  assert.equal(cleaned, true)
  await runtime.mount(providerOptions(), context => { context.services.provide(counterToken, {}) })
})

test('access requires dependency declaration, manifest permission, group policy and instance grant', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  await runtime.mount(providerOptions(), context => { context.services.provide(counterToken, {}) })
  const options = consumerOptions()
  options.grants = []
  const consumer = await runtime.mount(options, () => {})
  assert.throws(() => consumer.context.services.require(counterToken), { code: 'CAPABILITY_NOT_GRANTED' })
  const plain = await runtime.mount(pluginOptions('test.plain'), () => {})
  assert.throws(() => plain.context.services.require(counterToken), { code: 'SERVICE_NOT_DECLARED' })
  assert.throws(() => plain.context.capabilities.require('network:connect'), { code: 'CAPABILITY_NOT_DECLARED' })
})

test('scoped permission denies an out-of-scope request', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  const options = pluginOptions('test.network', {}, ['network:connect'])
  options.policy[0].scope = { host: ['localhost'], port: 443 }
  const handle = await runtime.mount(options, () => {})
  assert.doesNotThrow(() => handle.context.capabilities.require('network:connect', { host: 'localhost', port: 443 }))
  assert.throws(() => handle.context.capabilities.require('network:connect', { host: 'example.invalid', port: 443 }), { code: 'PERMISSION_DENIED' })
  assert.throws(() => handle.context.capabilities.require('network:connect'), { code: 'PERMISSION_DENIED' })
})

test('an incompatible service version is rejected', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  await runtime.mount(providerOptions(), context => { context.services.provide(counterToken, {}) })
  const options = consumerOptions()
  options.manifest.requires.services.required[0].version = '^2.0.0'
  const handle = await runtime.mount(options, () => {})
  assert.throws(() => handle.context.services.require(counterToken), { code: 'VERSION_MISMATCH' })
})

test('event pipeline orders by constraints, snapshots payloads and disposes listeners', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  const publisher = await runtime.mount(providerOptions(), () => {})
  const order = []
  const later = await runtime.mount(pluginOptions('test.later', {}, ['event:intercept.test.counter.changed']), context => {
    context.events.use(changeEvent, 'modify', payload => {
      order.push('later')
      return { action: 'continue', value: { count: payload.count * 2 } }
    }, { after: ['test.earlier'] })
  })
  await runtime.mount(pluginOptions('test.earlier', {}, ['event:intercept.test.counter.changed']), context => {
    context.events.use(changeEvent, 'modify', payload => {
      order.push('earlier')
      assert.equal(Object.isFrozen(payload), true)
      return { action: 'continue', value: { count: payload.count + 1 } }
    })
  })
  const received = []
  const consumer = await runtime.mount(consumerOptions(), context => {
    context.events.on(changeEvent, payload => { received.push(payload) })
  })
  const input = { count: 1 }
  assert.deepEqual(await publisher.context.events.emit(changeEvent, input), { action: 'continue', value: { count: 4 } })
  assert.deepEqual(order, ['earlier', 'later'])
  assert.deepEqual(input, { count: 1 })
  assert.deepEqual(received, [{ count: 4 }])
  await consumer.dispose()
  await later.dispose()
  await publisher.context.events.emit(changeEvent, { count: 0 })
  assert.equal(received.length, 1)
})

test('middleware cycles are rejected at registration', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  const first = await runtime.mount(pluginOptions('test.first', {}, ['event:intercept.test.counter.changed']), () => {})
  const second = await runtime.mount(pluginOptions('test.second', {}, ['event:intercept.test.counter.changed']), () => {})
  first.context.events.use(changeEvent, 'first', payload => ({ action: 'continue', value: payload }), { after: ['test.second'] })
  assert.throws(() => second.context.events.use(changeEvent, 'second', payload => ({ action: 'continue', value: payload }), { after: ['test.first'] }), { code: 'MIDDLEWARE_CYCLE' })
})

test('stop suppresses notification and retry is restricted to retryable events', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  const publisher = await runtime.mount(providerOptions(), () => {})
  const filter = await runtime.mount(pluginOptions('test.filter', {}, ['event:intercept.test.counter.changed']), () => {})
  const remove = filter.context.events.use(changeEvent, 'filter', () => ({ action: 'stop', reason: 'filtered' }))
  assert.deepEqual(await publisher.context.events.emit(changeEvent, { count: 1 }), { action: 'stop', reason: 'filtered' })
  await remove()
  filter.context.events.use(changeEvent, 'retry', () => ({ action: 'retry', delayMs: 10 }))
  await assert.rejects(publisher.context.events.emit(changeEvent, { count: 1 }), { code: 'RETRY_NOT_ALLOWED' })
  await assert.rejects(publisher.context.events.emit({ ...changeEvent, retryable: true }, { count: 1 }), { code: 'RETRY_NOT_ALLOWED' })
  await publisher.dispose()
  const options = providerOptions()
  options.manifest.provides.events = [{ ...changeEvent, retryable: true }]
  const retryable = await runtime.mount(options, () => {})
  assert.equal((await retryable.context.events.emit(changeEvent, { count: 1 })).action, 'retry')
})

test('non-JSON or cyclic event payloads cannot cross plugin boundaries', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  const publisher = await runtime.mount(providerOptions(), () => {})
  const cyclic = {}
  cyclic.self = cyclic
  for (const payload of [new Map(), { bad: undefined }, { count: NaN }, cyclic]) {
    await assert.rejects(publisher.context.events.emit(changeEvent, payload), { code: 'INVALID_PAYLOAD' })
  }
})

test('disposed plugin context is revoked and runtime shutdown is idempotent', async () => {
  const runtime = createCoreRuntime()
  const consumer = await runtime.mount(consumerOptions(), () => {})
  await consumer.dispose()
  assert.throws(() => consumer.context.services.get(counterToken), { code: 'SCOPE_DISPOSED' })
  await runtime.dispose()
  await runtime.dispose()
  await assert.rejects(runtime.mount(providerOptions(), () => {}), { code: 'RUNTIME_DISPOSED' })
})

test('identity conflicts and wrong runtime are rejected', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  await runtime.mount(providerOptions(), () => {})
  await assert.rejects(runtime.mount(providerOptions(), () => {}), { code: 'INSTANCE_CONFLICT' })
  const options = consumerOptions()
  options.manifest.pluginId = 'test.wrong'
  await assert.rejects(runtime.mount(options, () => {}), error => error instanceof CoreError && error.code === 'MANIFEST_MISMATCH')
  options.manifest.pluginId = options.identity.pluginId
  options.manifest.runtime.kind = 'child-process'
  await assert.rejects(runtime.mount(options, () => {}), /in-process/)
})

test('serial notifications do not bail when listeners accidentally return values', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  const publisher = await runtime.mount(providerOptions(), () => {})
  const received = []
  await runtime.mount(consumerOptions(), context => {
    context.events.on(changeEvent, () => received.push('first'))
    context.events.on(changeEvent, () => received.push('second'))
  })
  await publisher.context.events.emit(changeEvent, { count: 1 })
  assert.deepEqual(received, ['first', 'second'])
})

test('logs retain host identity rather than caller-supplied identity', async t => {
  const records = []
  const sink = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map(level => [
    level, (message, fields) => records.push({ level, message, ...fields }),
  ]))
  const runtime = createCoreRuntime({ logger: sink })
  t.after(() => runtime.dispose())
  const handle = await runtime.mount(providerOptions(), () => {})
  handle.context.logger.info('identity', { instanceId: 'forged', pluginId: 'forged' })
  assert.equal(records[0].instanceId, 'test.provider')
  assert.equal(records[0].pluginId, 'test.provider')
  assert.equal(typeof records[0].timestamp, 'string')
})

test('caller mutation cannot change mounted grants or event policy', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  const options = consumerOptions()
  options.grants = []
  const handle = await runtime.mount(options, () => {})
  options.grants.push({ id: 'service:test.counter', instanceId: 'test.consumer' })
  assert.throws(() => handle.context.services.get(counterToken), { code: 'CAPABILITY_NOT_GRANTED' })
})

test('instance grants are not inherited from a different plugin instance', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  const options = consumerOptions()
  options.grants = [{ id: 'service:test.counter', instanceId: 'another-instance' }]
  const handle = await runtime.mount(options, () => {})
  assert.throws(() => handle.context.services.get(counterToken), { code: 'CAPABILITY_NOT_GRANTED' })
})

test('startup and cleanup errors are both preserved', async t => {
  const runtime = createCoreRuntime()
  t.after(() => runtime.dispose())
  await assert.rejects(runtime.mount(providerOptions(), context => {
    context.lifecycle.add(() => { throw new Error('cleanup failed') })
    throw new Error('startup failed')
  }), error => {
    assert.equal(error instanceof AggregateError, true)
    assert.match(error.errors[0].message, /startup failed/)
    assert.equal(error.errors[1] instanceof AggregateError, true)
    return true
  })
})
