import test from 'node:test'
import assert from 'node:assert/strict'
import { createCoreRuntime } from '../packages/core/dist/index.js'
import { resolveDependencies } from '../packages/loader/dist/index.js'
import { codeIs, harness, logger, pair, permission, plugin, service } from './fixtures/loader.mjs'

test('dependency resolution is deterministic and precedes all plugin execution', async context => {
  const messages = []
  const { directory, loader } = await harness(context, { logger: { ...logger, info: (text, fields) => messages.push([text, fields]) } })
  await pair(directory, loader)
  const plan = await loader.resolve()
  assert.deepEqual(plan.order, ['provider', 'consumer'])
  plan.dependencies.clear()
  const transitions = []
  loader.subscribe(status => transitions.push(`${status.identity.instanceId}:${status.state}`))
  await loader.start('consumer')
  assert.equal(loader.status('consumer').state, 'running')
  assert.equal(messages.find(([text]) => text === 'consumer-started')[1].value, 42)
  assert.ok(transitions.indexOf('provider:running') < transitions.indexOf('consumer:starting'))
  assert.ok(transitions.includes('consumer:ready'))
})

test('required missing dependencies fail resolution without importing a plugin', async context => {
  const { directory, loader } = await harness(context)
  await loader.discover(await plugin(directory, 'missing', { code: "throw new Error('should-not-import')", manifest: { requires: { plugins: { required: [{ pluginId: 'example.absent', version: '^1.0.0' }] } } } }))
  await assert.rejects(loader.startAll(), codeIs('DEPENDENCY_NOT_FOUND'))
  assert.equal(loader.status('missing').state, 'discovered')
})

test('dependency cycles and duplicate service providers are rejected before startup', async context => {
  const { directory, loader } = await harness(context)
  const left = await loader.discover(await plugin(directory, 'left', { manifest: { requires: { plugins: { required: [{ pluginId: 'example.right', version: '*' }] } } } }))
  const right = await loader.discover(await plugin(directory, 'right', { manifest: { requires: { plugins: { optional: [{ pluginId: 'example.left', version: '*' }] } } } }))
  assert.throws(() => resolveDependencies([left, right]), codeIs('DEPENDENCY_CYCLE'))
  const first = await loader.discover(await plugin(directory, 'first', { manifest: { provides: { services: [service] } } }))
  const second = await loader.discover(await plugin(directory, 'second', { manifest: { provides: { services: [service] } } }))
  assert.throws(() => resolveDependencies([first, second]), codeIs('SERVICE_CONFLICT'))
})

test('required versions and ambiguous plugin instances require explicit resolution', async context => {
  const { directory, loader } = await harness(context)
  const provider = await loader.discover(await plugin(directory, 'provider'))
  const incompatible = await loader.discover(await plugin(directory, 'consumer', { manifest: { requires: { plugins: { required: [{ pluginId: 'example.provider', version: '^2.0.0' }] } } } }))
  assert.throws(() => resolveDependencies([provider, incompatible]), codeIs('VERSION_MISMATCH'))
  const compatible = await loader.discover(await plugin(directory, 'compatible', { manifest: { requires: { plugins: { required: [{ pluginId: 'example.provider', version: '^1.0.0' }] } } } }))
  const duplicate = { ...provider, identity: { ...provider.identity, instanceId: 'provider-two' } }
  assert.throws(() => resolveDependencies([provider, duplicate, compatible]), codeIs('DEPENDENCY_NOT_FOUND'))
})

test('absent optional dependencies start degraded; optional stop policy never activates', async context => {
  const { directory, loader } = await harness(context)
  const requires = { plugins: { optional: [{ pluginId: 'example.absent', version: '*' }] } }
  await loader.discover(await plugin(directory, 'optional', { manifest: { requires } }))
  await loader.discover(await plugin(directory, 'optional-stop', { code: "throw new Error('must-not-import')", manifest: { requires, lifecycle: { optionalDependencyFailure: 'stop' } } }))
  await loader.start('optional')
  assert.equal(loader.status('optional').state, 'degraded')
  assert.deepEqual(loader.status('optional').reasons, ['plugin:example.absent'])
  await assert.rejects(loader.start('optional-stop'), AggregateError)
  assert.match(loader.status('optional-stop').error, /dependencies unavailable/)
})

test('required provider failure stops consumers and leaves independent plugins running', async context => {
  const { directory, loader } = await harness(context)
  await pair(directory, loader, {}, {}, "export function apply() { throw new Error('provider-failed') }")
  await loader.discover(await plugin(directory, 'independent'))
  await assert.rejects(loader.startAll(), AggregateError)
  assert.equal(loader.status('provider').state, 'failed')
  assert.equal(loader.status('consumer').state, 'failed')
  assert.equal(loader.status('independent').state, 'running')
})

test('stopping a provider disposes transitive consumers first and permits explicit re-enable', async context => {
  const messages = []
  const { directory, loader } = await harness(context, { logger: { ...logger, info: text => messages.push(text) } })
  await pair(directory, loader)
  await loader.discover(await plugin(directory, 'last', { manifest: { requires: { plugins: { required: [{ pluginId: 'example.consumer', version: '^1.0.0' }] } } }, code: "export function apply(context) { return () => context.logger.info('last-stopped') }" }))
  await loader.startAll()
  await loader.stop('provider')
  assert.equal(loader.status('consumer').state, 'stopped')
  assert.equal(loader.status('last').state, 'stopped')
  assert.ok(messages.indexOf('last-stopped') < messages.indexOf('consumer-stopped'))
  assert.ok(messages.indexOf('consumer-stopped') < messages.indexOf('provider-disposer'))
  await loader.start('consumer')
  assert.equal(loader.status('provider').state, 'running')
  assert.equal(loader.status('consumer').state, 'running')
  assert.equal(loader.status('last').state, 'stopped')
})

test('service readiness loss stops required consumers and degrades optional consumers', async context => {
  const runtime = createCoreRuntime({ logger })
  context.after(() => runtime.dispose())
  const { directory, loader } = await harness(context, { runtime })
  const key = `easybot-registration-${directory}`
  await pair(directory, loader, {}, {}, `export function apply(context) { globalThis[${JSON.stringify(key)}] = context.services.provide(${JSON.stringify(service)}, { read: () => 42 }) }`)
  await loader.discover(await plugin(directory, 'optional', { manifest: { requires: { services: { optional: [{ id: service.id, version: '^1.0.0' }] } }, permissions: [permission] } }))
  await loader.startAll()
  const registration = globalThis[key]
  context.after(() => { delete globalThis[key] })
  assert.deepEqual(runtime.inspectService(service.id), { id: service.id, instanceId: 'provider', version: service.version, readiness: 'ready' })
  registration.setReadiness('unavailable')
  await loader.idle()
  assert.equal(loader.status('provider').state, 'degraded')
  assert.equal(loader.status('consumer').state, 'stopped')
  assert.equal(loader.status('optional').state, 'degraded')
  registration.setReadiness('ready')
  await loader.idle()
  assert.equal(loader.status('provider').state, 'running')
  assert.equal(loader.status('optional').state, 'running')
  assert.equal(loader.status('consumer').state, 'stopped')
  await loader.start('consumer')
  assert.equal(loader.status('consumer').state, 'running')
})

test('host capability availability propagates to required and optional dependencies', async context => {
  const { directory, loader } = await harness(context, { capabilities: [{ id: 'example.host', version: '1.0.0' }] })
  await loader.discover(await plugin(directory, 'required', { manifest: { requires: { capabilities: { required: [{ id: 'example.host', version: '^1.0.0' }] } } } }))
  await loader.discover(await plugin(directory, 'optional', { manifest: { requires: { capabilities: { optional: [{ id: 'example.host' }] } } } }))
  await loader.startAll()
  await loader.setCapabilityAvailability('example.host', false)
  assert.equal(loader.status('required').state, 'stopped')
  assert.equal(loader.status('optional').state, 'degraded')
  await loader.setCapabilityAvailability('example.host', true)
  assert.equal(loader.status('optional').state, 'running')
  assert.equal(loader.status('required').state, 'stopped')
})

test('child-process manifests are never silently loaded in-process', async context => {
  const { directory, loader } = await harness(context)
  await loader.discover(await plugin(directory, 'child', { code: "throw new Error('must-not-import')", manifest: { runtime: { kind: 'child-process', entry: './index.js', protocolVersion: 1 } } }))
  await assert.rejects(loader.start('child'), AggregateError)
  assert.match(loader.status('child').error, /must-not-import/)
})

test('reported runtime failures clean resources and stop dependent plugins', async context => {
  const { directory, loader } = await harness(context)
  await pair(directory, loader, { lifecycle: { restart: { enabled: true, maxAttempts: 1, delayMs: 0 } } })
  await loader.startAll()
  await loader.reportFailure('provider', new Error('connection-crashed'))
  assert.equal(loader.status('provider').state, 'failed')
  assert.equal(loader.status('consumer').state, 'stopped')
  await loader.retry('provider')
  assert.equal(loader.status('provider').state, 'running')
  assert.equal(loader.status('provider').restartAttempts, 1)
  assert.equal(loader.status('consumer').state, 'stopped')
})

test('bounded retries quarantine a repeatedly failing plugin', async context => {
  const { directory, loader } = await harness(context)
  await loader.discover(await plugin(directory, 'failing', { code: "export function apply() { throw new Error('fails') }", manifest: { lifecycle: { restart: { enabled: true, maxAttempts: 2, delayMs: 0, backoff: 'exponential' } } } }))
  await assert.rejects(loader.startAll(), AggregateError)
  await assert.rejects(loader.retry('failing'), codeIs('PLUGIN_START_FAILED'))
  assert.equal(loader.status('failing').state, 'failed')
  await assert.rejects(loader.retry('failing'), codeIs('PLUGIN_START_FAILED'))
  assert.equal(loader.status('failing').state, 'quarantined')
  assert.equal(loader.status('failing').restartAttempts, 2)
  await assert.rejects(loader.retry('failing'), codeIs('INVALID_LIFECYCLE_STATE'))
})

test('cleanup failures do not prevent independent cleanup or leak services', async context => {
  const runtime = createCoreRuntime({ logger })
  context.after(() => runtime.dispose())
  const { directory, loader } = await harness(context, { runtime })
  await pair(directory, loader, {}, {}, `export function apply(context) { context.services.provide(${JSON.stringify(service)}, { read: () => 42 }); return () => { throw new Error('dispose-failed') } }`)
  await loader.startAll()
  await assert.rejects(loader.stopAll(), AggregateError)
  assert.equal(loader.status('provider').state, 'failed')
  assert.equal(loader.status('consumer').state, 'stopped')
  assert.equal(runtime.inspectService(service.id), undefined)
})

test('observer failures are isolated and diagnostics are retrievable', async context => {
  const { directory, loader } = await harness(context)
  loader.subscribe(() => { throw new Error('observer-failed') })
  await loader.discover(await plugin(directory, 'observed'))
  await loader.startAll()
  assert.equal(loader.status('observed').state, 'running')
  assert.ok(loader.takeDiagnostics().length >= 4)
  assert.equal(loader.takeDiagnostics().length, 0)
})

test('discover rejects changing topology while running and snapshots caller metadata', async context => {
  const { directory, loader } = await harness(context)
  const options = await plugin(directory, 'metadata')
  options.config = { nested: { value: 1 } }
  const discovery = loader.discover(options)
  options.config.nested.value = 2
  options.instanceId = 'changed'
  const discovered = await discovery
  assert.equal(discovered.identity.instanceId, 'metadata')
  assert.deepEqual(discovered.config, { nested: { value: 1 } })
  await loader.startAll()
  await assert.rejects(loader.discover(await plugin(directory, 'new')), codeIs('INVALID_LIFECYCLE_STATE'))
})

test('dispose is idempotent, rejects new operations and preserves a borrowed runtime', async context => {
  const runtime = createCoreRuntime({ logger })
  context.after(() => runtime.dispose())
  const { directory, loader } = await harness(context, { runtime })
  await loader.discover(await plugin(directory, 'managed'))
  await loader.startAll()
  const first = loader.dispose()
  assert.equal(loader.dispose(), first)
  await first
  assert.equal(loader.status('managed').state, 'stopped')
  await assert.rejects(loader.startAll(), codeIs('RUNTIME_DISPOSED'))
  const host = await runtime.mount({ identity: { pluginId: 'example.host', packageName: '@example/host', version: '1.0.0', instanceId: 'host' }, manifest: { schemaVersion: 1, pluginId: 'example.host', displayName: 'Host', runtime: { kind: 'in-process', entry: './index.js' } } }, () => {})
  await host.dispose()
})

test('concurrent commands are serialized and activate and clean a plugin exactly once', async context => {
  const messages = []
  const { directory, loader } = await harness(context, { logger: { ...logger, info: text => messages.push(text) } })
  await loader.discover(await plugin(directory, 'serial', { code: "export function apply(context) { context.logger.info('activated'); return () => context.logger.info('disposed') }" }))
  const started = loader.start('serial')
  const secondStart = loader.start('serial')
  const stopped = loader.stop('serial')
  assert.equal((await started).state, 'running')
  assert.equal((await secondStart).state, 'running')
  assert.equal((await stopped).state, 'stopped')
  assert.deepEqual(messages, ['activated', 'disposed'])
})

test('disposal cancels queued retry delays instead of waiting for the backoff', { timeout: 2000 }, async context => {
  const { directory, loader } = await harness(context)
  await loader.discover(await plugin(directory, 'delayed', { code: "export function apply() { throw new Error('failure') }", manifest: { lifecycle: { restart: { enabled: true, maxAttempts: 1, delayMs: 60000, maxDelayMs: 60000 } } } }))
  await assert.rejects(loader.start('delayed'), AggregateError)
  const retry = loader.retry('delayed').then(() => undefined, error => error)
  await new Promise(resolve => setImmediate(resolve))
  await loader.dispose()
  assert.equal((await retry).name, 'AbortError')
  assert.equal(loader.status('delayed').state, 'stopped')
})

test('a provider that does not register its promised service is degraded, not ready for consumers', async context => {
  const { directory, loader } = await harness(context)
  await pair(directory, loader, {}, {}, 'export function apply() {}')
  await assert.rejects(loader.startAll(), AggregateError)
  assert.equal(loader.status('provider').state, 'degraded')
  assert.deepEqual(loader.status('provider').reasons, ['provided-service:example.value'])
  assert.equal(loader.status('consumer').state, 'failed')
})

test('invalid apply return values clean services registered before the error', async context => {
  const runtime = createCoreRuntime({ logger })
  context.after(() => runtime.dispose())
  const { directory, loader } = await harness(context, { runtime })
  await loader.discover(await plugin(directory, 'invalid-dispose', { manifest: { provides: { services: [service] } }, code: `export function apply(context) { context.services.provide(${JSON.stringify(service)}, { read: () => 42 }); return 'not-a-disposer' }` }))
  await assert.rejects(loader.startAll(), AggregateError)
  assert.equal(loader.status('invalid-dispose').state, 'failed')
  assert.equal(runtime.inspectService(service.id), undefined)
})

test('default plugin objects load, while embedded manifest mismatches fail startup', async context => {
  const { directory, loader } = await harness(context)
  await loader.discover(await plugin(directory, 'default-object', { code: 'export default { apply() {} }' }))
  await loader.discover(await plugin(directory, 'mismatch', { code: "export default { manifest: { pluginId: 'example.other' }, apply() {} }" }))
  await assert.rejects(loader.startAll(), AggregateError)
  assert.equal(loader.status('default-object').state, 'running')
  assert.equal(loader.status('mismatch').state, 'failed')
  assert.match(loader.status('mismatch').error, /manifest differs/)
})
