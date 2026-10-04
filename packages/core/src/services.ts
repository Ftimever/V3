import type { PluginContext, PluginManifest, ServiceAccess, ServiceReadiness, ServiceRegistration, ServiceToken } from '@easybot/contracts'
import { Context } from 'cordis'
import { satisfies, valid } from 'semver'
import { CoreError } from './errors.js'
import type { CapabilityAccess } from './permissions.js'
import type { LifecycleScope } from './scope.js'

interface ServiceRecord {
  readonly instanceId: string
  readonly version: string
  readonly value: unknown
  readonly factory?: (requester: PluginContext) => unknown
  readonly methods?: readonly string[]
  readiness: ServiceReadiness
}

export interface ServiceStatus {
  readonly id: string
  readonly instanceId: string
  readonly version: string
  readonly readiness: ServiceReadiness
  readonly methods?: readonly string[]
}

export type { ServiceAccess, ServiceRegistration } from '@easybot/contracts'

export function defineService<Service>(definition: { id: string; version: string; methods?: readonly string[] }): ServiceToken<Service> {
  if (!definition.id || !valid(definition.version)) throw new TypeError('Service requires an ID and a SemVer version')
  return Object.freeze({ ...definition })
}

export class ServiceRegistry {
  private readonly records = new Map<string, ServiceRecord>()

  constructor(private readonly onChange: () => void = () => {}, private readonly bindings: Readonly<Record<string, string>> = {}) {}

  private key(id: string, instanceId: string): string { return JSON.stringify([id, instanceId]) }

  private select(id: string, implementation = this.bindings[id]): ServiceRecord | undefined {
    if (implementation) return this.records.get(this.key(id, implementation))
    return [...this.records].find(([key]) => (JSON.parse(key) as string[])[0] === id)?.[1]
  }

  inspect(id: string, implementation?: string): ServiceStatus | undefined {
    const record = this.select(id, implementation)
    if (!record) return undefined
    return Object.freeze({ id, instanceId: record.instanceId, version: record.version, readiness: record.readiness, ...(record.methods ? { methods: record.methods } : {}) })
  }

  forPlugin(context: Context, instanceId: string, manifest: PluginManifest, scope: LifecycleScope, capabilities: CapabilityAccess, requester: () => PluginContext): ServiceAccess {
    const scoped = new Map<ServiceRecord, unknown>()
    const valueFor = (record: ServiceRecord): unknown => {
      if (!record.factory) return record.value
      if (!scoped.has(record)) scoped.set(record, record.factory(requester()))
      return scoped.get(record)
    }
    const lookup = <Service>(token: ServiceToken<Service>): ServiceRecord | undefined => {
      scope.assertActive()
      const dependencies = [...manifest.requires?.services?.required ?? [], ...manifest.requires?.services?.optional ?? []]
      const dependency = dependencies.find(item => item.id === token.id)
      if (!dependency) throw new CoreError('SERVICE_NOT_DECLARED', token.id)
      capabilities.require(`service:${token.id}`)
      const record = this.select(token.id)
      if (record && (!satisfies(record.version, dependency.version) || !satisfies(record.version, `^${token.version}`))) {
        throw new CoreError('VERSION_MISMATCH', `Incompatible service: ${token.id}@${record.version}`)
      }
      return record
    }

    const provide = <Service>(token: ServiceToken<Service>, value: Service, readiness: ServiceReadiness = 'ready', factory?: (requester: PluginContext) => unknown): ServiceRegistration => {
        scope.assertActive()
        const declaration = manifest.provides?.services?.find(service => service.id === token.id)
        if (!declaration || declaration.version !== token.version) throw new CoreError('SERVICE_NOT_DECLARED', token.id)
        if (value === undefined) throw new TypeError('Service value cannot be undefined')
        const key = this.key(token.id, instanceId)
        if (this.records.has(key) || !this.bindings[token.id] && this.select(token.id)) throw new CoreError('SERVICE_CONFLICT', token.id)
        const record: ServiceRecord = { instanceId, version: token.version, value, readiness, factory, methods: declaration.methods }
        const remove = context.provide(`easybot.service.${key}`, record)
        this.records.set(key, record)
        const dispose = scope.add(async () => {
          if (this.records.get(key) === record) {
            this.records.delete(key)
            this.onChange()
          }
          await remove()
        })
        this.onChange()
        return Object.freeze({
          dispose,
          setReadiness: (state: ServiceReadiness): void => {
            scope.assertActive()
            if (this.records.get(key) !== record) throw new CoreError('SERVICE_NOT_FOUND', token.id)
            record.readiness = state
            this.onChange()
          },
        })
      }
    return Object.freeze({
      provide,
      provideScoped: <Service>(token: ServiceToken<Service>, factory: (requester: PluginContext) => Service, readiness: ServiceReadiness = 'ready') => provide(token as ServiceToken<unknown>, factory, readiness, factory),
      get: <Service>(token: ServiceToken<Service>): Service | undefined => {
        const record = lookup(token)
        return record?.readiness === 'ready' ? valueFor(record) as Service : undefined
      },
      require: <Service>(token: ServiceToken<Service>): Service => {
        const record = lookup(token)
        if (!record) throw new CoreError('SERVICE_NOT_FOUND', token.id)
        if (record.readiness !== 'ready') throw new CoreError('SERVICE_NOT_READY', token.id)
        return valueFor(record) as Service
      },
      readiness: <Service>(token: ServiceToken<Service>): ServiceReadiness | undefined => lookup(token)?.readiness,
    })
  }
}
