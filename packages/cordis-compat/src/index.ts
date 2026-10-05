import type { Dispose, EventDefinition, JsonObject, PluginContext, ServiceToken } from '@easybot/contracts'

export interface CordisCompatContext {
  readonly plugin: PluginContext['plugin']
  readonly services: PluginContext['services']
  readonly events: PluginContext['events']
  readonly effect: (dispose: Dispose) => Dispose
  readonly on: <TPayload>(event: EventDefinition<TPayload>, listener: (payload: TPayload) => void | Promise<void>) => Dispose
  readonly emit: <TPayload>(event: EventDefinition<TPayload>, payload: TPayload) => ReturnType<PluginContext['events']['emit']>
  readonly require: <TService>(token: ServiceToken<TService>) => TService
  readonly provide: <TService>(token: ServiceToken<TService>, service: TService) => Dispose
  readonly provideScoped: <TService>(token: ServiceToken<TService>, factory: (requester: PluginContext) => TService) => Dispose
  readonly requireCapability: (permission: Parameters<PluginContext['capabilities']['require']>[0], target?: JsonObject) => void
}

export function createCordisCompat(context: PluginContext): CordisCompatContext {
  const require = <TService>(token: ServiceToken<TService>): TService => context.services.require(token)
  const provide = <TService>(token: ServiceToken<TService>, service: TService): Dispose => context.services.provide(token, service).dispose
  const provideScoped = <TService>(token: ServiceToken<TService>, factory: (requester: PluginContext) => TService): Dispose => context.services.provideScoped(token, factory).dispose
  const on = <TPayload>(event: EventDefinition<TPayload>, listener: (payload: TPayload) => void | Promise<void>): Dispose => context.events.on(event, listener)
  const emit = <TPayload>(event: EventDefinition<TPayload>, payload: TPayload): ReturnType<PluginContext['events']['emit']> => context.events.emit(event, payload)
  const requireCapability = (permission: Parameters<PluginContext['capabilities']['require']>[0], target?: JsonObject): void => context.capabilities.require(permission, target)
  return Object.freeze({
    plugin: context.plugin,
    services: context.services,
    events: context.events,
    effect: (dispose: Dispose): Dispose => context.lifecycle.add(dispose),
    on,
    emit,
    require,
    provide,
    provideScoped,
    requireCapability,
  })
}

export const cordisCompat = Object.freeze({
  experimental: true,
  create: createCordisCompat,
})
