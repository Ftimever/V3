import { createCoreRuntime, defineService } from '../packages/core/dist/index.js'

const counter = defineService({ id: 'example.counter', version: '1.0.0' })
const changed = { id: 'example.counter.changed', version: '1.0.0' }
const runtime = createCoreRuntime()

function options(pluginId, manifest, permissions = []) {
  return {
    identity: { pluginId, packageName: `@example/${pluginId}`, version: '1.0.0', instanceId: pluginId },
    manifest: {
      schemaVersion: 1,
      pluginId,
      displayName: pluginId,
      runtime: { kind: 'in-process', entry: './index.mjs' },
      permissions: permissions.map(id => ({ id })),
      ...manifest,
    },
    policy: permissions.map(id => ({ id })),
    grants: permissions.map(id => ({ id, instanceId: pluginId })),
  }
}

try {
  const provider = await runtime.mount(options('example.provider', {
    provides: { services: [counter], events: [changed] },
  }, ['event:publish.example.counter.changed']), context => {
    let count = 0
    context.services.provide(counter, { increment: () => ++count })
  })
  const consumer = await runtime.mount(options('example.consumer', {
    requires: { services: { required: [{ id: counter.id, version: '^1.0.0' }] } },
  }, ['service:example.counter', 'event:subscribe.example.counter.changed']), context => {
    context.events.on(changed, payload => context.logger.info('counter changed', payload))
  })
  const count = consumer.context.services.require(counter).increment()
  await provider.context.events.emit(changed, { count })
  console.log(`Counter result: ${count}`)
} finally {
  await runtime.dispose()
}
