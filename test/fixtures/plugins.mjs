export const counterToken = { id: 'test.counter', version: '1.0.0' }
export const changeEvent = { id: 'test.counter.changed', version: '1.0.0', delivery: 'pipeline' }

export function pluginOptions(pluginId, overrides = {}, permissions = []) {
  const identity = {
    pluginId,
    packageName: `@easybot-test/${pluginId.replaceAll('.', '-')}`,
    version: '1.0.0',
    instanceId: pluginId,
    groupId: 'test.group',
  }
  return {
    identity,
    manifest: {
      schemaVersion: 1,
      pluginId,
      displayName: pluginId,
      runtime: { kind: 'in-process', entry: './index.mjs' },
      permissions: permissions.map(id => ({ id })),
      ...overrides,
    },
    policy: permissions.map(id => ({ id })),
    grants: permissions.map(id => ({ id, instanceId: identity.instanceId })),
  }
}

export function providerOptions() {
  return pluginOptions('test.provider', { provides: { services: [counterToken], events: [changeEvent] } }, [
    `event:publish.${changeEvent.id}`,
  ])
}

export function consumerOptions() {
  return pluginOptions('test.consumer', { requires: { services: { required: [{ ...counterToken, version: '^1.0.0' }] } } }, [
    'service:test.counter',
    `event:subscribe.${changeEvent.id}`,
  ])
}
