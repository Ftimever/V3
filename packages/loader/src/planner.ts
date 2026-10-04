import { satisfies, valid } from 'semver'
import type { ServiceReference } from '@easybot/contracts'
import { LoaderError } from './errors.js'
import type { DependencyPlan, DiscoveredPlugin, HostCapability, InstanceDependencies } from './types.js'

export function resolveDependencies(plugins: readonly DiscoveredPlugin[], capabilities: readonly HostCapability[] = [], bindings: Readonly<Record<string, string>> = {}, hostServices: readonly ServiceReference[] = []): DependencyPlan {
  const instances = new Map(plugins.map(plugin => [plugin.identity.instanceId, plugin]))
  if (instances.size !== plugins.length) throw new LoaderError('INSTANCE_CONFLICT', 'Duplicate instance ID')
  const host = new Map(capabilities.map(capability => [capability.id, capability]))
  if (host.size !== capabilities.length || capabilities.some(capability => !capability.id || !valid(capability.version))) {
    throw new LoaderError('INVALID_MANIFEST', 'Host capabilities require unique IDs and SemVer versions')
  }
  const services = new Map<string, DiscoveredPlugin>()
  for (const plugin of plugins) {
    for (const service of plugin.manifest.provides?.services ?? []) {
      if (services.has(service.id) && !bindings[service.id]) throw new LoaderError('SERVICE_CONFLICT', `Multiple providers for ${service.id}; explicit binding required`)
      if (!bindings[service.id] || bindings[service.id] === plugin.identity.instanceId) services.set(service.id, plugin)
    }
  }
  for (const [id, instanceId] of Object.entries(bindings)) {
    const implementation = instances.get(instanceId)
    if (!implementation?.manifest.provides?.services?.some(service => service.id === id)) throw new LoaderError('DEPENDENCY_NOT_FOUND', `Invalid binding ${id} -> ${instanceId}`)
    services.set(id, implementation)
  }
  const dependencies = new Map<string, InstanceDependencies>()
  for (const plugin of plugins) {
    const required = new Set<string>()
    const optional = new Set<string>()
    const missingOptional: string[] = []
    for (const mode of ['required', 'optional'] as const) {
      const select = (label: string, candidates: readonly DiscoveredPlugin[], compatible: readonly DiscoveredPlugin[]): void => {
        if (compatible.length > 1) throw new LoaderError('DEPENDENCY_NOT_FOUND', `Ambiguous ${label} for ${plugin.identity.instanceId}`)
        const provider = compatible[0]
        if (!provider) {
          if (mode === 'optional') {
            missingOptional.push(label)
            return
          }
          throw new LoaderError(candidates.length ? 'VERSION_MISMATCH' : 'DEPENDENCY_NOT_FOUND', `${plugin.identity.instanceId} requires ${label}`)
        }
        if (provider.identity.instanceId === plugin.identity.instanceId) throw new LoaderError('DEPENDENCY_CYCLE', `Self dependency: ${label}`)
        if (mode === 'required') required.add(provider.identity.instanceId)
        else optional.add(provider.identity.instanceId)
      }
      for (const dependency of plugin.manifest.requires?.plugins?.[mode] ?? []) {
        const candidates = plugins.filter(candidate => candidate.manifest.pluginId === dependency.pluginId)
        select(`plugin:${dependency.pluginId}`, candidates, candidates.filter(candidate => satisfies(candidate.identity.version, dependency.version)))
      }
      for (const dependency of plugin.manifest.requires?.services?.[mode] ?? []) {
        const provider = services.get(dependency.id)
        const hosted = hostServices.find(service => service.id === dependency.id)
        if (!provider && hosted && !bindings[dependency.id]) {
          if (satisfies(hosted.version, dependency.version)) continue
          if (mode === 'optional') { missingOptional.push(`service:${dependency.id}`); continue }
          throw new LoaderError('VERSION_MISMATCH', `Host service version mismatch: ${dependency.id}`)
        }
        const candidates = provider ? [provider] : []
        const declaration = provider?.manifest.provides?.services?.find(service => service.id === dependency.id)
        select(`service:${dependency.id}`, candidates, declaration && satisfies(declaration.version, dependency.version) ? candidates : [])
      }
      for (const dependency of plugin.manifest.requires?.capabilities?.[mode] ?? []) {
        const capability = host.get(dependency.id)
        if (!capability || dependency.version && !satisfies(capability.version, dependency.version)) {
          if (mode === 'required') throw new LoaderError(capability ? 'VERSION_MISMATCH' : 'DEPENDENCY_NOT_FOUND', `Missing host capability: ${dependency.id}`)
          missingOptional.push(`capability:${dependency.id}`)
        }
      }
    }
    for (const instanceId of required) optional.delete(instanceId)
    dependencies.set(plugin.identity.instanceId, Object.freeze({ required: Object.freeze([...required].sort()), optional: Object.freeze([...optional].sort()), missingOptional: Object.freeze(missingOptional.sort()) }))
  }
  const order: string[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (instanceId: string): void => {
    if (visited.has(instanceId)) return
    if (visiting.has(instanceId)) throw new LoaderError('DEPENDENCY_CYCLE', `Dependency cycle at ${instanceId}`)
    visiting.add(instanceId)
    const node = dependencies.get(instanceId)!
    for (const providerId of [...node.required, ...node.optional].sort()) visit(providerId)
    visiting.delete(instanceId)
    visited.add(instanceId)
    order.push(instanceId)
  }
  for (const instanceId of [...instances.keys()].sort()) visit(instanceId)
  return Object.freeze({ order: Object.freeze(order), dependencies })
}
