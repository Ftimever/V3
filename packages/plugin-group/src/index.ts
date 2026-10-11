import Ajv2020 from 'ajv/dist/2020.js'
import { satisfies, valid, validRange } from 'semver'
import { snapshotJson, type JsonObject, type PermissionGrant, type PermissionRequest, type PluginGroupManifest, type PluginTrustLevel } from '@easybot/contracts'
import { pluginGroupManifestSchema } from '@easybot/contracts/schemas'
import { createPluginLoader, LoaderError, type DiscoveredPlugin, type LoaderOptions, type PluginLoader, type PluginSource } from '@easybot/loader'
import { StateStore } from '@easybot/state'
import { PackageInstaller, type PackageSnapshot } from './installer.js'

export { PackageInstaller, directoryIntegrity, type InstallerOptions, type PackageSnapshot } from './installer.js'
export interface GroupMemberInput { readonly source: PluginSource; readonly trust: PluginTrustLevel; readonly config?: JsonObject }
export interface GroupDeployment {
  readonly manifest: PluginGroupManifest
  readonly members: readonly { readonly instanceId: string; readonly snapshot: PackageSnapshot; readonly trust: PluginTrustLevel; readonly config: JsonObject }[]
}
export interface GroupRecord {
  readonly state: 'stable' | 'applying' | 'rollback-failed'
  readonly enabled: boolean
  readonly active?: GroupDeployment
  readonly previous?: GroupDeployment
  readonly pending?: GroupDeployment
  readonly error?: string
}
export interface GroupManagerOptions {
  readonly store: StateStore
  readonly installer: PackageInstaller
  readonly loader?: Omit<LoaderOptions, 'runtime' | 'serviceBindings'>
  readonly grants?: (groupId: string, instanceId: string, policy: readonly PermissionRequest[]) => readonly PermissionGrant[]
  readonly bootstrap?: (loader: PluginLoader, groupId: string) => Promise<void>
  readonly configure?: (loader: PluginLoader, plugin: DiscoveredPlugin, groupVersion: string) => Promise<void>
}

const validate = new Ajv2020({ strictRequired: false, allowUnionTypes: true }).compile<PluginGroupManifest>(pluginGroupManifestSchema)

export function parseGroupManifest(input: unknown): PluginGroupManifest {
  if (!validate(input) || !valid(input.version)) throw new LoaderError('INVALID_MANIFEST', 'Invalid group manifest or version')
  const ids = input.members.map(member => member.instanceId)
  if (!ids.length || new Set(ids).size !== ids.length || input.members.some(member => !validRange(member.version))) throw new LoaderError('INVALID_MANIFEST', 'Group needs unique members and SemVer ranges')
  for (const grant of input.permissions ?? []) if (!ids.includes(grant.instanceId)) throw new LoaderError('INVALID_MANIFEST', 'Group permission references an unknown member')
  for (const binding of Object.values(input.serviceBindings ?? {})) if (!ids.includes(binding.implementation)) throw new LoaderError('INVALID_MANIFEST', 'Group binding references an unknown member')
  return snapshotJson(input) as unknown as PluginGroupManifest
}

export class PluginGroupManager {
  private readonly loaders = new Map<string, PluginLoader>()
  private readonly queues = new Map<string, Promise<void>>()
  private disposal?: Promise<void>

  constructor(private readonly options: GroupManagerOptions) {}

  private enqueue<Result>(id: string, action: () => Promise<Result>): Promise<Result> {
    if (this.disposal) return Promise.reject(new LoaderError('RUNTIME_DISPOSED', 'Group manager disposed'))
    const result = (this.queues.get(id) ?? Promise.resolve()).then(action)
    this.queues.set(id, result.then(() => {}, () => {}))
    return result
  }

  get(groupId: string): GroupRecord | undefined {
    return this.options.store.get('groups', groupId)?.value as unknown as GroupRecord | undefined
  }

  list(): readonly { readonly groupId: string; readonly record: GroupRecord }[] {
    return this.options.store.keys('groups').map(groupId => ({ groupId, record: this.get(groupId)! }))
  }

  runtime(groupId: string): PluginLoader | undefined { return this.loaders.get(groupId) }

  private write(groupId: string, record: GroupRecord): void {
    const previous = this.options.store.get('groups', groupId)
    this.options.store.put('groups', groupId, snapshotJson(record), previous?.revision ?? 0)
  }

  deploy(manifestInput: PluginGroupManifest, inputs: Readonly<Record<string, GroupMemberInput>>): Promise<GroupRecord> {
    let manifest: PluginGroupManifest
    let selections: Readonly<Record<string, GroupMemberInput>>
    try { manifest = parseGroupManifest(manifestInput); selections = structuredClone(inputs) } catch (error) { return Promise.reject(error) }
    return this.enqueue(manifest.groupId, async () => {
      const members: GroupDeployment['members'][number][] = []
      if (Object.keys(selections).some(id => !manifest.members.some(member => member.instanceId === id))) throw new LoaderError('INVALID_MANIFEST', 'Unknown source selection')
      for (const member of manifest.members) {
        const input = selections[member.instanceId]
        if (!input || !['trusted', 'isolated', 'privileged'].includes(input.trust)) throw new LoaderError('INVALID_MANIFEST', 'Every member needs a source and explicit trust selection')
        const snapshot = await this.options.installer.snapshot(input.source)
        if (snapshot.packageName !== member.packageName || !satisfies(snapshot.version, member.version)) throw new LoaderError('VERSION_MISMATCH', `Group member differs from package lock: ${member.instanceId}`)
        members.push({ instanceId: member.instanceId, snapshot, trust: input.trust, config: input.config ?? {} })
      }
      const deployment = snapshotJson({ manifest, members }) as unknown as GroupDeployment
      return this.activate(deployment)
    })
  }

  private async prepare(deployment: GroupDeployment): Promise<PluginLoader> {
    const manifest = parseGroupManifest(deployment.manifest)
    const bindings = Object.fromEntries(Object.entries(manifest.serviceBindings ?? {}).map(([id, binding]) => [id, binding.implementation]))
    const loader = createPluginLoader({ ...this.options.loader, serviceBindings: bindings })
    const providerCounts = new Map<string, number>()
    try {
      await this.options.bootstrap?.(loader, manifest.groupId)
      for (const member of manifest.members) {
        const locked = deployment.members.find(item => item.instanceId === member.instanceId)
        if (!locked || !satisfies(locked.snapshot.version, member.version) || locked.snapshot.packageName !== member.packageName) throw new LoaderError('INVALID_MANIFEST', 'Invalid deployment lock')
        await this.options.installer.verify(locked.snapshot)
        const policy = (manifest.permissions ?? []).filter(permission => permission.instanceId === member.instanceId).map(({ instanceId: _instanceId, ...permission }) => permission)
        const grants = this.options.grants?.(manifest.groupId, member.instanceId, policy) ?? []
        const discovered = await loader.discover({ instanceId: member.instanceId, groupId: manifest.groupId, source: { kind: 'local', path: locked.snapshot.directory }, trust: locked.trust, config: locked.config, policy, grants })
        if (discovered.identity.pluginId !== member.pluginId || discovered.identity.version !== locked.snapshot.version || discovered.identity.packageName !== locked.snapshot.packageName) throw new LoaderError('MANIFEST_MISMATCH', 'Deployment identity mismatch')
        if (member.runtime && (member.runtime.kind !== discovered.manifest.runtime.kind || member.runtime.entry !== discovered.manifest.runtime.entry || member.runtime.trust !== locked.trust || (member.runtime.protocolVersion ?? 1) !== (discovered.manifest.runtime.protocolVersion ?? 1))) throw new LoaderError('MANIFEST_MISMATCH', 'Group runtime selection differs from plugin declaration')
        for (const service of discovered.manifest.provides?.services ?? []) providerCounts.set(service.id, (providerCounts.get(service.id) ?? 0) + 1)
        await this.options.configure?.(loader, discovered, manifest.version)
      }
      for (const [id, binding] of Object.entries(manifest.serviceBindings ?? {})) {
        if (!binding.allowOverride && (providerCounts.get(id) ?? 0) > 1) throw new LoaderError('PERMISSION_DENIED', `Group does not allow replacement of ${id}`)
      }
      await loader.resolve()
      return loader
    } catch (error) { await loader.dispose().catch(() => {}); throw error }
  }

  private async startReady(loader: PluginLoader): Promise<void> {
    const statuses = await loader.startAll()
    if (statuses.some(status => !['running', 'degraded'].includes(status.state) || status.reasons.some(reason => reason.startsWith('provided-service:')))) throw new LoaderError('SERVICE_NOT_READY', 'Group deployment did not reach required readiness')
  }

  private async activate(deployment: GroupDeployment): Promise<GroupRecord> {
    const groupId = deployment.manifest.groupId
    const previous = this.get(groupId)
    const next = await this.prepare(deployment)
    let old = this.loaders.get(groupId)
    if (!old && previous?.active && previous.enabled) {
      old = await this.prepare(previous.active)
      await this.startReady(old)
      this.loaders.set(groupId, old)
    }
    this.write(groupId, { state: 'applying', enabled: true, ...(previous?.active ? { active: previous.active } : {}), pending: deployment })
    try {
      await old?.stopAll()
      await this.startReady(next)
      const record: GroupRecord = { state: 'stable', enabled: true, active: deployment, ...(previous?.active ? { previous: previous.active } : {}) }
      this.write(groupId, record)
      this.loaders.set(groupId, next)
      await old?.dispose().catch(() => {})
      return record
    } catch (error) {
      await next.dispose().catch(() => {})
      let rollbackError: unknown
      try { if (old && previous?.enabled) await this.startReady(old) } catch (failure) { rollbackError = failure }
      const record: GroupRecord = { state: rollbackError ? 'rollback-failed' : 'stable', enabled: previous?.enabled ?? false, ...(previous?.active ? { active: previous.active } : {}), ...(previous?.previous ? { previous: previous.previous } : {}), error: error instanceof Error ? error.message : String(error) }
      this.write(groupId, record)
      throw new LoaderError('PLUGIN_START_FAILED', rollbackError ? 'Deployment and rollback failed' : 'Deployment failed; previous deployment restored', { cause: rollbackError ? new AggregateError([error, rollbackError]) : error })
    }
  }

  rollback(groupId: string): Promise<GroupRecord> {
    return this.enqueue(groupId, async () => {
      const record = this.get(groupId)
      if (!record?.previous) throw new LoaderError('DEPENDENCY_NOT_FOUND', 'No previous deployment')
      return this.activate(record.previous)
    })
  }

  stop(groupId: string): Promise<void> {
    return this.enqueue(groupId, async () => {
      const record = this.get(groupId)
      if (!record) throw new LoaderError('DEPENDENCY_NOT_FOUND', groupId)
      await this.loaders.get(groupId)?.stopAll()
      this.write(groupId, { ...record, enabled: false })
    })
  }

  start(groupId: string): Promise<void> {
    return this.enqueue(groupId, async () => {
      const record = this.get(groupId)
      if (!record?.active) throw new LoaderError('DEPENDENCY_NOT_FOUND', groupId)
      const loader = this.loaders.get(groupId) ?? await this.prepare(record.active)
      try {
        await this.startReady(loader)
        this.loaders.set(groupId, loader)
        this.write(groupId, { state: 'stable', enabled: true, active: record.active, ...(record.previous ? { previous: record.previous } : {}) })
      } catch (error) { await loader.dispose().catch(() => {}); this.loaders.delete(groupId); throw error }
    })
  }

  async restore(): Promise<void> {
    const errors: unknown[] = []
    for (const { groupId, record } of this.list()) {
      if (record.enabled && record.active) {
        try {
          await this.start(groupId)
        } catch (error) {
          const current = this.get(groupId) ?? record
          this.write(groupId, { ...current, state: 'stable', enabled: false, error: error instanceof Error ? error.message : String(error) })
          errors.push(error)
        }
      } else if (record.state === 'applying') this.write(groupId, { state: 'stable', enabled: false, ...(record.active ? { active: record.active } : {}), error: 'Interrupted deployment reverted to last committed deployment' })
    }
    if (errors.length) throw new AggregateError(errors, `Some plugin groups failed to restore: ${errors.map(error => error instanceof Error ? error.message : String(error)).join('; ')}`)
  }

  dispose(): Promise<void> {
    if (!this.disposal) this.disposal = (async () => {
      await Promise.all(this.queues.values())
      const results = await Promise.allSettled([...this.loaders.values()].map(loader => loader.dispose()))
      this.loaders.clear()
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Group shutdown failed')
    })()
    return this.disposal
  }
}
