import type { Logger, PluginContext, PluginDefinition, ServiceAccess, EventAccess } from '../../packages/contracts/dist/index.js'
import type { PluginContext as RuntimeContext, PluginHandle } from '../../packages/core/dist/index.js'
import { defineService } from '../../packages/core/dist/index.js'
import type { DiscoveredPlugin, PluginStatus } from '../../packages/loader/dist/index.js'
import type { PluginIdentity, PluginLifecycleState, PluginManifest } from '../../packages/contracts/dist/index.js'

type Assert<Condition extends true> = Condition
type Assignable<Source, Target> = Source extends Target ? true : false

export type ContextCompatibility = Assert<Assignable<RuntimeContext, PluginContext>>
export type ServiceCompatibility = Assert<Assignable<RuntimeContext['services'], ServiceAccess>>
export type EventCompatibility = Assert<Assignable<RuntimeContext['events'], EventAccess>>
export type LoggerCompatibility = Assert<Assignable<RuntimeContext['logger'], Logger>>
export type HandleCompatibility = Assert<Assignable<PluginHandle['context'], PluginContext>>
export type LoaderManifestCompatibility = Assert<Assignable<DiscoveredPlugin['manifest'], PluginManifest>>
export type LoaderIdentityCompatibility = Assert<Assignable<DiscoveredPlugin['identity'], PluginIdentity>>
export type LoaderStateCompatibility = Assert<Assignable<PluginStatus['state'], PluginLifecycleState>>

const counter = defineService<{ read(): number }>({ id: 'example.counter', version: '1.0.0' })

export const consumer: PluginDefinition = {
  manifest: {
    schemaVersion: 1,
    pluginId: 'example.consumer',
    displayName: 'Consumer',
    runtime: { kind: 'in-process', entry: './index.js' },
    requires: { services: { required: [{ id: counter.id, version: '^1.0.0' }] } },
    permissions: [{ id: 'service:example.counter' }],
  },
  apply(context): void {
    const count: number = context.services.require(counter).read()
    context.logger.info('read', { count })
    context.lifecycle.add(() => {})
  },
}
