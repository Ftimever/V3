import type {
  EventAccess, EventDefinition, EventListener, EventMiddleware, EventMiddlewareOrdering,
  PipelineResult, PluginIdentity, PluginManifest,
} from '@easybot/contracts'
import { Context } from 'cordis'
import { CoreError } from './errors.js'
import type { CapabilityAccess } from './permissions.js'
import type { Dispose, LifecycleScope } from './scope.js'

interface MiddlewareEntry {
  readonly id: string
  readonly pluginId: string
  readonly dependencies: readonly string[]
  readonly ordering: EventMiddlewareOrdering
  readonly run: (payload: unknown) => PipelineResult<unknown> | Promise<PipelineResult<unknown>>
}

export type { EventAccess } from '@easybot/contracts'

function snapshot<Value>(value: Value): Value {
  const ancestors = new Set<unknown>()
  const validate = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object' || !item) throw new CoreError('INVALID_PAYLOAD', 'Events require JSON-compatible payloads')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new CoreError('INVALID_PAYLOAD', 'Events cannot contain native or custom objects')
    }
    if (ancestors.has(item)) throw new CoreError('INVALID_PAYLOAD', 'Event payload is cyclic')
    ancestors.add(item)
    for (const child of Object.values(item)) validate(child)
    ancestors.delete(item)
  }
  validate(value)
  const copy: Value = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return
    Object.freeze(item)
    for (const child of Object.values(item)) freeze(child)
  }
  freeze(copy)
  return copy
}

function sortMiddleware(entries: readonly MiddlewareEntry[]): MiddlewareEntry[] {
  const pending = new Map(entries.map(entry => [entry.id, new Set<string>()]))
  for (const entry of entries) {
    for (const other of entries) {
      if (entry.id === other.id) continue
      if (entry.ordering.after?.includes(other.pluginId) || entry.dependencies.includes(other.pluginId)) {
        pending.get(entry.id)?.add(other.id)
      }
      if (entry.ordering.before?.includes(other.pluginId)) pending.get(other.id)?.add(entry.id)
    }
  }
  const result: MiddlewareEntry[] = []
  while (pending.size) {
    const available = [...pending].filter(([, dependencies]) => !dependencies.size).map(([id]) => id).sort()
    if (!available.length) throw new CoreError('MIDDLEWARE_CYCLE', [...pending.keys()].join(', '))
    for (const id of available) {
      const entry = entries.find(item => item.id === id)
      if (entry) result.push(entry)
      pending.delete(id)
      for (const dependencies of pending.values()) dependencies.delete(id)
    }
  }
  return result
}

export class EventBus {
  private readonly keys = new Map<string, symbol>()
  private readonly middleware = new Map<string, MiddlewareEntry[]>()

  constructor(private readonly root: Context) {}

  private key(event: EventDefinition<unknown>): symbol {
    const id = `${event.id}@${event.version}`
    let key = this.keys.get(id)
    if (!key) {
      key = Symbol(id)
      this.keys.set(id, key)
    }
    return key
  }

  forPlugin(context: Context, plugin: PluginIdentity, manifest: PluginManifest, scope: LifecycleScope, capabilities: CapabilityAccess): EventAccess {
    return Object.freeze({
      on: <Payload>(event: EventDefinition<Payload>, listener: EventListener<Payload>): Dispose => {
        scope.assertActive()
        capabilities.require(`event:subscribe.${event.id}`)
        const remove = context.on(this.key(event), async (payload: Payload): Promise<void> => {
          scope.assertActive()
          await listener(payload)
        })
        return scope.add(() => { remove() })
      },
      use: <Payload>(event: EventDefinition<Payload>, id: string, middleware: EventMiddleware<Payload>, ordering: EventMiddlewareOrdering = {}): Dispose => {
        scope.assertActive()
        capabilities.require(`event:intercept.${event.id}`)
        const key = `${event.id}@${event.version}`
        const entries = this.middleware.get(key) ?? []
        const entry: MiddlewareEntry = {
          id: `${plugin.instanceId}:${id}`,
          pluginId: plugin.pluginId,
          dependencies: [...manifest.requires?.plugins?.required ?? [], ...manifest.requires?.plugins?.optional ?? []].map(item => item.pluginId),
          ordering: { before: ordering.before ? [...ordering.before] : undefined, after: ordering.after ? [...ordering.after] : undefined },
          run: payload => {
            scope.assertActive()
            return middleware(payload as Readonly<Payload>)
          },
        }
        if (entries.some(item => item.id === entry.id)) throw new CoreError('MIDDLEWARE_CONFLICT', entry.id)
        sortMiddleware([...entries, entry])
        entries.push(entry)
        this.middleware.set(key, entries)
        return scope.add(() => {
          const index = entries.indexOf(entry)
          if (index >= 0) entries.splice(index, 1)
        })
      },
      emit: async <Payload>(event: EventDefinition<Payload>, payload: Payload): Promise<PipelineResult<Payload>> => {
        scope.assertActive()
        const declaration = manifest.provides?.events?.find(item => item.id === event.id && item.version === event.version)
        if (!declaration) throw new CoreError('EVENT_NOT_DECLARED', event.id)
        capabilities.require(`event:publish.${event.id}`)
        let value = snapshot(payload)
        for (const entry of sortMiddleware(this.middleware.get(`${event.id}@${event.version}`) ?? [])) {
          scope.assertActive()
          const result = await entry.run(value)
          if (result.action === 'stop') return result
          if (result.action === 'retry') {
            if (!declaration.retryable) throw new CoreError('RETRY_NOT_ALLOWED', event.id)
            return result
          }
          value = snapshot(result.value as Payload)
        }
        scope.assertActive()
        if (declaration.delivery === 'parallel') await this.root.parallel(this.key(event), value)
        else await this.root.serial(this.key(event), value)
        return { action: 'continue', value }
      },
    })
  }
}
