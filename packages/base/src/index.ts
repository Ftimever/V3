import type { JsonValue, PluginDefinition, ServiceToken } from '@easybot/contracts'
import type { CoreRuntime } from '@easybot/core'
import { StateStore, SecretVault } from '@easybot/state'
import { LogBuffer } from './logs.js'
import { WebUiRegistry } from './webui.js'
import { httpFor, websocketFor } from './network.js'
import { storage, secrets, http, websocket, webui, log, type StorageService, type SecretService, type LogService } from './tokens.js'

export * from './tokens.js'
export { LogBuffer, type LogRecord } from './logs.js'
export { WebUiRegistry } from './webui.js'
export interface BaseOptions { readonly store: StateStore; readonly vault: SecretVault; readonly logs: LogBuffer; readonly webui: WebUiRegistry }

function definition(name: string, token: ServiceToken, apply: PluginDefinition['apply']): PluginDefinition {
  return Object.freeze({ manifest: { schemaVersion: 1 as const, pluginId: `base.${name}`, displayName: `Base ${name}`, runtime: { kind: 'in-process' as const, entry: './index.js' }, provides: { services: [token] } }, apply })
}

export function createBasePlugins(options: BaseOptions): readonly PluginDefinition[] {
  return [
    definition('storage', storage, context => { context.services.provideScoped(storage, requester => {
      const namespace = JSON.stringify(['plugin', requester.plugin.groupId ?? null, requester.plugin.instanceId])
      const check = (): void => { context.lifecycle.assertActive(); requester.capabilities.require('storage:own') }
      const service: StorageService = {
        get: async (key: string) => { check(); return options.store.get(namespace, key) ?? null },
        put: async (key: string, value: JsonValue, revision: number) => { check(); if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new TypeError('Storage value too large'); return options.store.put(namespace, key, value, revision) },
        delete: async (key: string, revision: number) => { check(); options.store.delete(namespace, key, revision) },
        keys: async () => { check(); return options.store.keys(namespace) },
      }
      return Object.freeze(service)
    }) }),
    definition('secrets', secrets, context => { context.services.provideScoped(secrets, requester => {
      const idFor = (id: string): string => JSON.stringify([requester.plugin.groupId ?? null, requester.plugin.instanceId, id])
      const check = (): void => { context.lifecycle.assertActive(); requester.capabilities.require('secret:own') }
      const service: SecretService = {
        get: async id => { check(); return options.vault.get(idFor(id)) ?? null },
        set: async (id, value) => { check(); if (Buffer.byteLength(value) > 65536) throw new TypeError('Secret too large'); options.vault.set(idFor(id), value) },
        delete: async id => { check(); options.vault.delete(idFor(id)) },
      }
      return Object.freeze(service)
    }) }),
    definition('http', http, context => { context.services.provideScoped(http, httpFor) }),
    definition('websocket', websocket, context => { context.services.provideScoped(websocket, websocketFor) }),
    definition('webui', webui, context => { context.services.provideScoped(webui, requester => options.webui.forPlugin(requester)) }),
    definition('log', log, context => { context.services.provideScoped(log, requester => {
      const service: LogService = { write: async (level, message, fields) => { context.lifecycle.assertActive(); requester.lifecycle.assertActive(); options.logs.write(level, message, { ...fields, pluginId: requester.plugin.pluginId, instanceId: requester.plugin.instanceId, groupId: requester.plugin.groupId ?? null }) } }
      return Object.freeze(service)
    }) }),
  ]
}

export async function mountBasePlugins(runtime: CoreRuntime, options: BaseOptions, groupId?: string): Promise<void> {
  for (const plugin of createBasePlugins(options)) {
    const name = plugin.manifest.pluginId.split('.').at(-1)!
    await runtime.mount({ identity: { pluginId: plugin.manifest.pluginId, packageName: '@easybot/base', version: '0.1.0', instanceId: `base-${name}`, ...(groupId ? { groupId } : {}) }, manifest: plugin.manifest }, async context => { await plugin.apply(context, {}) })
  }
}
