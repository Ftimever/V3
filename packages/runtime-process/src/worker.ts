import { Console } from 'node:console'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { snapshotJson, type EventDefinition, type EventListener, type EventMiddleware, type EventMiddlewareOrdering, type JsonObject, type JsonValue, type PermissionGrant, type PermissionRequest, type PipelineResult, type PluginContext, type PluginDefinition, type PluginIdentity, type PluginManifest, type ServiceReadiness, type ServiceReference, type ServiceToken } from '@easybot/contracts'
import { createCapabilityAccess, LifecycleScope } from '@easybot/core'
import { RpcFault, RpcPeer } from '@easybot/rpc'

globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })
const peer = new RpcPeer(process.stdin, process.stdout, { identity: process.argv[2] ?? '', remoteIdentity: 'easybot.host', onClose: () => { void stop().finally(() => process.exit(1)) } })
const scope = new LifecycleScope()
const localServices = new Map<string, { token: ServiceToken; value: Record<string, unknown>; readiness: ServiceReadiness }>()
const callbacks = new Map<string, (value: JsonValue) => unknown>()
const operations: Promise<unknown>[] = []
let definition: PluginDefinition | undefined
let context: PluginContext | undefined
let started = false
let stopped = false

function fields(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcFault('INVALID_PAYLOAD', 'Expected object')
  return value as JsonObject
}
function schedule(method: string, payload: JsonValue): void {
  const operation = peer.request(method, payload)
  operations.push(operation)
  void operation.catch(error => { if (started && !stopped) { console.error(error); process.exitCode = 1; void stop().finally(() => process.exit(1)) } })
}
async function flush(): Promise<void> { await Promise.all(operations.splice(0)) }
async function stop(): Promise<void> {
  if (stopped) return
  stopped = true
  await scope.dispose()
}

peer.handle('runtime.start', async value => {
  if (started || context || stopped) throw new RpcFault('INVALID_LIFECYCLE_STATE', 'Worker already initialized')
  const request = fields(value)
  const manifest = request.manifest as unknown as PluginManifest
  const identity = request.identity as unknown as PluginIdentity
  if (identity.instanceId !== process.argv[2] || manifest.runtime.kind !== 'child-process') throw new RpcFault('MANIFEST_MISMATCH', 'Worker identity mismatch')
  const capabilities = createCapabilityAccess(scope, manifest.permissions ?? [], request.policy as unknown as PermissionRequest[], (request.grants as unknown as PermissionGrant[]).filter(grant => grant.instanceId === identity.instanceId))
  const available = new Map((request.services as unknown as ServiceReference[]).map(service => [service.id, service]))
  const lookup = <Service>(token: ServiceToken<Service>): Service | undefined => {
    scope.assertActive()
    if (![...manifest.requires?.services?.required ?? [], ...manifest.requires?.services?.optional ?? []].some(item => item.id === token.id)) throw new RpcFault('SERVICE_NOT_DECLARED', token.id)
    capabilities.require(`service:${token.id}`)
    const descriptor = available.get(token.id)
    if (!descriptor) return undefined
    return Object.freeze(Object.fromEntries((descriptor.methods ?? []).map(method => [method, (...args: JsonValue[]) => {
      scope.assertActive()
      return peer.request('services.call', snapshotJson({ token, method, args }))
    }]))) as Service
  }
  const registerEvent = (event: EventDefinition, callback: (value: JsonValue) => unknown, kind: string, ordering?: EventMiddlewareOrdering, name: string = randomUUID()): (() => Promise<void>) => {
    scope.assertActive()
    capabilities.require(`event:${kind === 'middleware' ? 'intercept' : 'subscribe'}.${event.id}`)
    const id = `${kind}:${name}`
    if (callbacks.has(id)) throw new RpcFault('MIDDLEWARE_CONFLICT', id)
    callbacks.set(id, callback)
    schedule('events.register', snapshotJson({ id, event, kind, ...(ordering ? { ordering } : {}) }))
    return scope.add(async () => { callbacks.delete(id); if (!stopped) await peer.request('events.remove', { id }) }) as () => Promise<void>
  }
  context = Object.freeze({
    plugin: Object.freeze(identity), lifecycle: scope, capabilities,
    logger: Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map(level => [level, (message: string, fields?: object) => console.error(JSON.stringify({ level, message, ...fields }))])) as unknown as PluginContext['logger'],
    services: Object.freeze({
      get: lookup,
      require: <Service>(token: ServiceToken<Service>): Service => { const service = lookup(token); if (!service) throw new RpcFault('SERVICE_NOT_FOUND', token.id); return service },
      readiness: (token: ServiceToken) => lookup(token) === undefined ? undefined : 'ready' as const,
      provideScoped: () => { throw new RpcFault('PERMISSION_DENIED', 'Requester-scoped providers must run in the host process') },
      provide: <Service>(token: ServiceToken<Service>, service: Service, readiness: ServiceReadiness = 'ready') => {
        scope.assertActive()
        const declaration = manifest.provides?.services?.find(item => item.id === token.id && item.version === token.version)
        if (!declaration?.methods?.length) throw new RpcFault('SERVICE_NOT_DECLARED', 'Exported service methods must be declared')
        if (localServices.has(token.id)) throw new RpcFault('SERVICE_CONFLICT', token.id)
        const object = service as Record<string, unknown>
        for (const method of declaration.methods) if (typeof object?.[method] !== 'function') throw new RpcFault('METHOD_NOT_FOUND', method)
        localServices.set(token.id, { token: { ...token, methods: declaration.methods }, value: object, readiness })
        schedule('services.provide', snapshotJson({ token, readiness }))
        return Object.freeze({
          setReadiness: (state: ServiceReadiness) => { scope.assertActive(); const record = localServices.get(token.id); if (!record) throw new RpcFault('SERVICE_NOT_FOUND', token.id); record.readiness = state; schedule('services.readiness', { id: token.id, state }) },
          dispose: scope.add(async () => { localServices.delete(token.id); if (!stopped) await peer.request('services.remove', { id: token.id }) }),
        })
      },
    }),
    events: Object.freeze({
      on: <Payload>(event: EventDefinition<Payload>, listener: EventListener<Payload>) => registerEvent(event, value => listener(value as Readonly<Payload>), 'listener'),
      use: <Payload>(event: EventDefinition<Payload>, id: string, middleware: EventMiddleware<Payload>, ordering?: EventMiddlewareOrdering) => registerEvent(event, value => middleware(value as Readonly<Payload>), 'middleware', ordering, id),
      emit: async <Payload>(event: EventDefinition<Payload>, value: Payload): Promise<PipelineResult<Payload>> => {
        scope.assertActive()
        capabilities.require(`event:publish.${event.id}`)
        await flush()
        return await peer.request('events.emit', snapshotJson({ event, value })) as unknown as PipelineResult<Payload>
      },
    }),
  })
  const module = await import(pathToFileURL(String(request.entry)).href) as { apply?: unknown; default?: unknown }
  definition = (typeof module.apply === 'function' ? module : module.default) as PluginDefinition
  if (typeof definition?.apply !== 'function') throw new RpcFault('INVALID_MANIFEST', 'Plugin must export apply')
  if (definition.manifest && !isDeepStrictEqual(definition.manifest, manifest)) throw new RpcFault('MANIFEST_MISMATCH', 'Entry manifest differs from plugin.json')
  const dispose = await definition.apply(context, request.config as JsonObject)
  if (dispose !== undefined && typeof dispose !== 'function') throw new RpcFault('INVALID_MANIFEST', 'Invalid apply return value')
  if (dispose) scope.add(dispose)
  await flush()
  started = true
})
peer.handle('services.invoke', async value => {
  scope.assertActive()
  const request = fields(value)
  const service = localServices.get(String(request.id))
  if (!service || service.readiness !== 'ready') throw new RpcFault('SERVICE_NOT_READY', String(request.id))
  const declaration = context && definition?.manifest?.provides?.services?.find(item => item.id === request.id)
  const method = String(request.method)
  if (!(declaration?.methods ?? service.token.methods)?.includes(method) || !Array.isArray(request.args)) throw new RpcFault('METHOD_NOT_FOUND', method)
  const implementation = service.value[method]
  if (typeof implementation !== 'function') throw new RpcFault('METHOD_NOT_FOUND', method)
  const result = await implementation.apply(service.value, request.args)
  return result === undefined ? undefined : snapshotJson(result)
})
peer.handle('events.dispatch', async value => {
  scope.assertActive()
  const request = fields(value)
  const callback = callbacks.get(String(request.id))
  if (!callback) throw new RpcFault('EVENT_NOT_DECLARED', String(request.id))
  const result = await callback(snapshotJson(request.value))
  return result === undefined ? undefined : snapshotJson(result)
})
peer.handle('runtime.reconfigure', async value => {
  scope.assertActive()
  if (!definition?.reconfigure || !context) throw new RpcFault('INVALID_CONFIG', 'Plugin does not support live reconfiguration')
  const request = fields(value)
  await definition.reconfigure(context, snapshotJson(request.next) as JsonObject, snapshotJson(request.previous) as JsonObject)
  await flush()
})
peer.handle('runtime.stop', async () => { await stop() })
