import type { Logger, LogFields, LogLevel, PermissionGrant, PermissionRequest, PluginIdentity, PluginManifest, PluginContext } from '@easybot/contracts'
import { Context } from 'cordis'
import { EventBus } from './events.js'
import { CoreError } from './errors.js'
import { createCapabilityAccess } from './permissions.js'
import { LifecycleScope, type Dispose } from './scope.js'
import { ServiceRegistry, type ServiceStatus } from './services.js'

export type { PluginContext } from '@easybot/contracts'

export interface MountOptions {
  readonly identity: PluginIdentity
  readonly manifest: PluginManifest
  readonly policy?: readonly PermissionRequest[]
  readonly grants?: readonly PermissionGrant[]
}

export interface PluginHandle {
  readonly context: PluginContext
  dispose: Dispose
}

export interface CoreRuntime {
  mount(options: MountOptions, activate: (context: PluginContext) => void | Promise<void>): Promise<PluginHandle>
  inspectService(id: string, implementation?: string): ServiceStatus | undefined
  subscribeServices(listener: () => void): Dispose
  dispose(): Promise<void>
}

export interface RuntimeOptions {
  readonly logger?: Logger
  readonly serviceBindings?: Readonly<Record<string, string>>
}

function scopedLogger(identity: PluginIdentity, sink?: Logger): Logger {
  const write = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    const record = { ...fields, pluginId: identity.pluginId, instanceId: identity.instanceId, groupId: identity.groupId, timestamp: new Date().toISOString() }
    if (sink) sink[level](message, record)
    else console.log({ level, message, ...record })
  }
  return Object.freeze({
    trace: (message: string, fields?: LogFields) => write('trace', message, fields),
    debug: (message: string, fields?: LogFields) => write('debug', message, fields),
    info: (message: string, fields?: LogFields) => write('info', message, fields),
    warn: (message: string, fields?: LogFields) => write('warn', message, fields),
    error: (message: string, fields?: LogFields) => write('error', message, fields),
    fatal: (message: string, fields?: LogFields) => write('fatal', message, fields),
  })
}

export function createCoreRuntime(runtimeOptions: RuntimeOptions = {}): CoreRuntime {
  const cordis = new Context()
  const observers = new Set<() => void>()
  const services = new ServiceRegistry(() => {
    for (const observer of [...observers]) {
      try {
        observer()
      } catch (error) {
        console.error('Service observer failed', error)
      }
    }
  }, Object.freeze({ ...runtimeOptions.serviceBindings }))
  const events = new EventBus(cordis)
  const rootScope = new LifecycleScope()
  const instances = new Set<string>()

  return Object.freeze({
    inspectService: (id: string, implementation?: string) => services.inspect(id, implementation),
    subscribeServices: (listener: () => void): Dispose => {
      rootScope.assertActive()
      observers.add(listener)
      return rootScope.add(() => { observers.delete(listener) })
    },
    async mount(options: MountOptions, activate: (context: PluginContext) => void | Promise<void>): Promise<PluginHandle> {
      if (rootScope.disposed) throw new CoreError('RUNTIME_DISPOSED', 'Runtime has been disposed')
      const metadata = structuredClone(options)
      const { identity, manifest } = metadata
      if (identity.pluginId !== manifest.pluginId) throw new CoreError('MANIFEST_MISMATCH', identity.instanceId)
      if (manifest.runtime.kind !== 'in-process') throw new TypeError('Core only mounts in-process plugins')
      if (instances.has(identity.instanceId)) throw new CoreError('INSTANCE_CONFLICT', identity.instanceId)
      instances.add(identity.instanceId)
      const scope = new LifecycleScope()
      let context: PluginContext | undefined
      let activationError: unknown
      let failed = false
      const fiber = cordis.plugin(async (pluginCordis: Context) => {
        const grants = metadata.grants?.filter(grant => grant.instanceId === identity.instanceId) ?? []
        const capabilities = createCapabilityAccess(scope, manifest.permissions ?? [], metadata.policy ?? [], grants)
        context = Object.freeze({
          plugin: Object.freeze(identity),
          services: services.forPlugin(pluginCordis, identity.instanceId, manifest, scope, capabilities, () => context!),
          events: events.forPlugin(pluginCordis, identity, manifest, scope, capabilities),
          lifecycle: scope,
          capabilities,
          logger: scopedLogger(identity, runtimeOptions.logger),
        })
        pluginCordis.effect(() => () => scope.dispose())
        try {
          await activate(context)
        } catch (error) {
          failed = true
          activationError = error
        }
      })
      const dispose = rootScope.add(async () => {
        try {
          await scope.dispose()
        } finally {
          try {
            await fiber.dispose()
          } finally {
            instances.delete(identity.instanceId)
          }
        }
      })
      try {
        await fiber.await()
        if (failed) throw activationError
        if (!context) throw new Error('Cordis did not activate the plugin')
        rootScope.assertActive()
        return Object.freeze({ context, dispose })
      } catch (error) {
        try {
          await dispose()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Activation and cleanup failed')
        }
        throw error
      }
    },
    async dispose(): Promise<void> {
      try {
        await rootScope.dispose()
      } finally {
        await cordis.fiber.dispose()
      }
    },
  })
}
