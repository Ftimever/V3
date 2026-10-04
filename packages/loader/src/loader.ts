import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { ConfigReloadPolicy, Dispose, JsonObject, PluginDefinition, PluginLifecycleState } from '@easybot/contracts'
import { startProcessPlugin, type ProcessHandle } from '@easybot/runtime-process'
import { createCoreRuntime, type CoreRuntime, type PluginHandle } from '@easybot/core'
import { satisfies } from 'semver'
import { discoverPlugin } from './discovery.js'
import { LoaderError } from './errors.js'
import { resolveDependencies } from './planner.js'
import type { DependencyPlan, DiscoverOptions, DiscoveredPlugin, HostCapability, LoaderOptions, PluginStatus } from './types.js'
import { parseConfig } from './validation.js'

interface InstanceRecord {
  plugin: DiscoveredPlugin
  readonly options: DiscoverOptions
  state: PluginLifecycleState
  restartAttempts: number
  reasons: readonly string[]
  error?: string
  handle?: PluginHandle
  definition?: PluginDefinition
  process?: ProcessHandle
  restartDependents?: ReadonlySet<string>
}

const transitions: Record<PluginLifecycleState, readonly PluginLifecycleState[]> = {
  discovered: ['resolved', 'stopped'],
  resolved: ['starting', 'stopped'],
  starting: ['ready', 'failed'],
  ready: ['running', 'degraded', 'stopping'],
  running: ['degraded', 'stopping'],
  degraded: ['running', 'stopping'],
  stopping: ['stopped', 'failed'],
  stopped: ['resolved'],
  failed: ['starting', 'quarantined', 'stopped'],
  quarantined: ['stopped'],
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PluginLoader {
  private readonly runtime: CoreRuntime
  private readonly records = new Map<string, InstanceRecord>()
  private readonly capabilities = new Map<string, HostCapability>()
  private readonly observers = new Set<(status: PluginStatus) => void>()
  private readonly diagnostics: unknown[] = []
  private readonly configRestarts = new Map<string, ReadonlySet<string>>()
  private readonly cancel = new AbortController()
  private readonly unsubscribeServices: Dispose
  private plan?: DependencyPlan
  private tail: Promise<void> = Promise.resolve()
  private disposal?: Promise<void>

  constructor(private readonly options: LoaderOptions = {}) {
    this.options = Object.freeze({ ...options })
    resolveDependencies([], options.capabilities)
    for (const capability of options.capabilities ?? []) this.capabilities.set(capability.id, Object.freeze({ ...capability }))
    this.runtime = options.runtime ?? createCoreRuntime(options)
    this.unsubscribeServices = this.runtime.subscribeServices(() => {
      if (this.disposal) return
      void this.enqueue(() => this.reconcile()).catch(error => { this.diagnostics.push(error) })
    })
  }

  get kernel(): CoreRuntime { return this.runtime }

  private enqueue<Result>(operation: () => Promise<Result> | Result): Promise<Result> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private assertOpen(): void {
    if (this.disposal) throw new LoaderError('RUNTIME_DISPOSED', 'Loader is stopping or disposed')
  }

  private record(instanceId: string): InstanceRecord {
    const record = this.records.get(instanceId)
    if (!record) throw new LoaderError('DEPENDENCY_NOT_FOUND', `Unknown instance: ${instanceId}`)
    return record
  }

  private snapshot(record: InstanceRecord): PluginStatus {
    return Object.freeze({ identity: record.plugin.identity, state: record.state, restartAttempts: record.restartAttempts, reasons: Object.freeze([...record.reasons]), ...(record.error ? { error: record.error } : {}) })
  }

  status(instanceId: string): PluginStatus {
    return this.snapshot(this.record(instanceId))
  }

  list(): readonly PluginStatus[] {
    return Object.freeze([...this.records.values()].sort((left, right) => left.plugin.identity.instanceId.localeCompare(right.plugin.identity.instanceId)).map(record => this.snapshot(record)))
  }

  subscribe(listener: (status: PluginStatus) => void): Dispose {
    this.assertOpen()
    this.observers.add(listener)
    return () => { this.observers.delete(listener) }
  }

  takeDiagnostics(): readonly unknown[] {
    return this.diagnostics.splice(0)
  }

  private publish(record: InstanceRecord): void {
    const status = this.snapshot(record)
    for (const observer of [...this.observers]) {
      try {
        observer(status)
      } catch (error) {
        this.diagnostics.push(error)
      }
    }
  }

  private transition(record: InstanceRecord, next: PluginLifecycleState, reasons: readonly string[] = []): void {
    if (next !== record.state && !transitions[record.state].includes(next)) {
      throw new LoaderError('INVALID_LIFECYCLE_STATE', `${record.state} -> ${next}: ${record.plugin.identity.instanceId}`)
    }
    if (next === record.state && isDeepStrictEqual(record.reasons, reasons)) return
    record.state = next
    record.reasons = reasons
    this.publish(record)
  }

  discover(options: DiscoverOptions): Promise<DiscoveredPlugin> {
    let metadata: DiscoverOptions
    try {
      metadata = structuredClone({ ...options, config: parseConfig(options.config ?? {}) })
    } catch (error) {
      return Promise.reject(error instanceof LoaderError ? error : new LoaderError('INVALID_MANIFEST', 'Invalid discovery metadata', { cause: error }))
    }
    return this.enqueue(async () => {
      this.assertOpen()
      if ([...this.records.values()].some(record => record.handle)) {
        throw new LoaderError('INVALID_LIFECYCLE_STATE', 'Stop all running instances before changing the discovered plugin set')
      }
      if (this.records.has(metadata.instanceId)) throw new LoaderError('INSTANCE_CONFLICT', metadata.instanceId)
      const plugin = await discoverPlugin(metadata, this.options.baseDirectory ?? process.cwd())
      const record: InstanceRecord = { plugin, options: metadata, state: 'discovered', restartAttempts: 0, reasons: [] }
      this.records.set(plugin.identity.instanceId, record)
      this.plan = undefined
      this.publish(record)
      return plugin
    })
  }

  private resolvePlan(): DependencyPlan {
    const plugins = [...this.records.values()].map(record => record.plugin)
    const hosted = plugins.flatMap(plugin => [...plugin.manifest.requires?.services?.required ?? [], ...plugin.manifest.requires?.services?.optional ?? []]).map(dependency => this.runtime.inspectService(dependency.id)).filter((service): service is NonNullable<typeof service> => service !== undefined && !this.records.has(service.instanceId))
    const plan = resolveDependencies(plugins, [...this.capabilities.values()], this.options.serviceBindings, hosted)
    this.plan = plan
    for (const instanceId of plan.order) {
      const record = this.record(instanceId)
      if (record.state === 'discovered') this.transition(record, 'resolved')
    }
    return plan
  }

  resolve(): Promise<DependencyPlan> {
    return this.enqueue(() => {
      this.assertOpen()
      const plan = this.resolvePlan()
      return Object.freeze({ order: plan.order, dependencies: new Map(plan.dependencies) })
    })
  }

  private active(record: InstanceRecord): boolean {
    return record.handle !== undefined && ['ready', 'running', 'degraded'].includes(record.state)
  }

  private dependencyIssues(record: InstanceRecord, mode: 'required' | 'optional'): string[] {
    const dependencies = this.plan?.dependencies.get(record.plugin.identity.instanceId)
    const issues = mode === 'optional' ? [...dependencies?.missingOptional ?? []] : []
    for (const instanceId of dependencies?.[mode] ?? []) {
      if (!this.active(this.record(instanceId))) issues.push(`plugin:${instanceId}`)
    }
    for (const dependency of record.plugin.manifest.requires?.services?.[mode] ?? []) {
      const service = this.runtime.inspectService(dependency.id)
      if (!service || service.readiness !== 'ready' || !satisfies(service.version, dependency.version)) issues.push(`service:${dependency.id}`)
    }
    for (const dependency of record.plugin.manifest.requires?.capabilities?.[mode] ?? []) {
      const capability = this.capabilities.get(dependency.id)
      if (!capability || capability.available === false || dependency.version && !satisfies(capability.version, dependency.version)) issues.push(`capability:${dependency.id}`)
    }
    return [...new Set(issues)].sort()
  }

  private refresh(record: InstanceRecord): void {
    if (!this.active(record)) return
    const reasons = this.dependencyIssues(record, 'optional')
    for (const declaration of record.plugin.manifest.provides?.services ?? []) {
      const service = this.runtime.inspectService(declaration.id, record.plugin.identity.instanceId)
      if (!service || service.instanceId !== record.plugin.identity.instanceId || service.readiness !== 'ready') reasons.push(`provided-service:${declaration.id}`)
    }
    this.transition(record, reasons.length ? 'degraded' : 'running', [...new Set(reasons)].sort())
  }

  private async startRecord(record: InstanceRecord, retry = false): Promise<void> {
    this.assertOpen()
    if (this.active(record)) return
    if (record.state === 'stopped') this.transition(record, 'resolved')
    if (record.state !== 'resolved' && !(retry && record.state === 'failed')) {
      throw new LoaderError('INVALID_LIFECYCLE_STATE', `Cannot start ${record.plugin.identity.instanceId} from ${record.state}`)
    }
    record.error = undefined
    this.transition(record, 'starting')
    try {
      const issues = this.dependencyIssues(record, 'required')
      if (record.plugin.manifest.lifecycle?.optionalDependencyFailure === 'stop') issues.push(...this.dependencyIssues(record, 'optional'))
      if (issues.length) throw new LoaderError('PLUGIN_UNAVAILABLE', `Required dependencies unavailable: ${issues.join(', ')}`)
      if (record.plugin.manifest.runtime.kind === 'child-process') {
        const manifest = { ...record.plugin.manifest, runtime: { ...record.plugin.manifest.runtime, kind: 'in-process' as const } }
        record.handle = await this.runtime.mount({ identity: record.plugin.identity, manifest, policy: record.options.policy, grants: record.options.grants }, async context => {
          record.process = await startProcessPlugin(context, { entry: record.plugin.entry, directory: record.plugin.directory, manifest: record.plugin.manifest, config: record.plugin.config, policy: record.options.policy, grants: record.options.grants, services: [...record.plugin.manifest.requires?.services?.required ?? [], ...record.plugin.manifest.requires?.services?.optional ?? []].map(dependency => this.runtime.inspectService(dependency.id)).filter(service => service !== undefined), startupTimeoutMs: this.options.processStartupTimeoutMs, shutdownTimeoutMs: this.options.processShutdownTimeoutMs, onFailure: error => {
            if (this.disposal) return
            void this.reportFailure(record.plugin.identity.instanceId, error).then(() => this.scheduleRestart(record)).catch(failure => { this.diagnostics.push(failure) })
          } })
        })
      } else {
      const imported: unknown = await import(pathToFileURL(record.plugin.entry).href)
      const module = imported as { apply?: unknown; default?: unknown }
      const definition = (typeof module.apply === 'function' ? module : module.default) as PluginDefinition | undefined
      if (!definition || typeof definition.apply !== 'function') throw new LoaderError('INVALID_MANIFEST', 'Plugin entry must export apply or a default plugin object with apply')
      if (definition.manifest !== undefined && !isDeepStrictEqual(definition.manifest, record.plugin.manifest)) {
        throw new LoaderError('MANIFEST_MISMATCH', 'Entry manifest differs from plugin.json')
      }
      record.definition = definition
      record.handle = await this.runtime.mount({ identity: record.plugin.identity, manifest: record.plugin.manifest, policy: record.options.policy, grants: record.options.grants }, async context => {
        const dispose = await definition.apply(context, record.plugin.config)
        if (dispose !== undefined && typeof dispose !== 'function') throw new LoaderError('INVALID_MANIFEST', 'Plugin apply must return a disposer or undefined')
        if (dispose) context.lifecycle.add(dispose)
        context.lifecycle.assertActive()
      })
      }
      this.transition(record, 'ready')
      this.refresh(record)
    } catch (error) {
      let cause = error
      if (record.handle) {
        const handle = record.handle
        record.handle = undefined
        try {
          await handle.dispose()
        } catch (cleanupError) {
          cause = new AggregateError([error, cleanupError], 'Startup and cleanup failed')
        }
      }
      record.error = message(cause)
      this.transition(record, 'failed')
      throw new LoaderError('PLUGIN_START_FAILED', `Failed to start ${record.plugin.identity.instanceId}: ${message(cause)}`, { cause })
    }
  }

  private scheduleRestart(record: InstanceRecord): void {
    if (this.disposal || record.state !== 'failed' || !record.plugin.manifest.lifecycle?.restart?.enabled) return
    void this.retry(record.plugin.identity.instanceId, true).catch(error => {
      this.diagnostics.push(error)
      if (!this.disposal && record.state === 'failed') this.scheduleRestart(record)
    })
  }

  reconfigure(instanceId: string, value: JsonObject, policy: ConfigReloadPolicy = 'restart'): Promise<void> {
    let snapshot: JsonObject
    try { snapshot = parseConfig(value) } catch (error) { return Promise.reject(error) }
    return this.enqueue(async () => {
      this.assertOpen()
      const record = this.record(instanceId)
      const validated = await discoverPlugin({ ...record.options, config: snapshot }, this.options.baseDirectory ?? process.cwd())
      if (!isDeepStrictEqual(validated.manifest, record.plugin.manifest) || validated.entry !== record.plugin.entry) throw new LoaderError('MANIFEST_MISMATCH', 'Configuration apply cannot replace plugin code or manifest')
      const previous = record.plugin.config
      if (policy === 'manual') throw new LoaderError('INVALID_CONFIG', 'Manual configuration requires explicit confirmation')
      if (!this.active(record) && !this.configRestarts.has(instanceId)) { record.plugin = Object.freeze({ ...record.plugin, config: snapshot }); return }
      if (policy === 'hot' || policy === 'reconnect') {
        if (record.process) await record.process.reconfigure(snapshot, previous)
        else if (record.definition?.reconfigure) await record.definition.reconfigure(record.handle!.context, snapshot, previous)
        else throw new LoaderError('INVALID_CONFIG', 'Plugin has no reconfigure hook; use restart')
        record.plugin = Object.freeze({ ...record.plugin, config: snapshot })
        return
      }
      const affected = this.dependentClosure(new Set([instanceId]))
      const active = this.configRestarts.get(instanceId) ?? new Set([...affected].filter(id => this.active(this.record(id))))
      this.configRestarts.set(instanceId, active)
      await this.stopAffected(affected, `reconfigure:${instanceId}`)
      record.plugin = Object.freeze({ ...record.plugin, config: snapshot })
      for (const id of this.plan!.order.filter(id => active.has(id))) {
        const target = this.record(id)
        if (target.state === 'failed') this.transition(target, 'stopped')
        await this.startRecord(target)
      }
      await this.reconcile()
      this.configRestarts.delete(instanceId)
    })
  }

  start(instanceId: string): Promise<PluginStatus> {
    return this.enqueue(async () => {
      this.assertOpen()
      const record = this.record(instanceId)
      const plan = this.plan ?? this.resolvePlan()
      const included = new Set<string>()
      const include = (id: string): void => {
        if (included.has(id)) return
        included.add(id)
        const dependencies = plan.dependencies.get(id)!
        for (const provider of [...dependencies.required, ...dependencies.optional]) include(provider)
      }
      include(instanceId)
      const errors: unknown[] = []
      for (const id of plan.order.filter(id => included.has(id))) {
        try {
          await this.startRecord(this.record(id))
        } catch (error) {
          errors.push(error)
        }
      }
      await this.reconcile()
      if (!this.active(record)) throw new AggregateError(errors, `Could not start ${instanceId}`)
      if (errors.length) this.diagnostics.push(...errors)
      return this.snapshot(record)
    })
  }

  startAll(): Promise<readonly PluginStatus[]> {
    return this.enqueue(async () => {
      this.assertOpen()
      const plan = this.plan ?? this.resolvePlan()
      const errors: unknown[] = []
      for (const instanceId of plan.order) {
        try {
          await this.startRecord(this.record(instanceId))
        } catch (error) {
          errors.push(error)
        }
      }
      await this.reconcile()
      if (errors.length) throw new AggregateError(errors, 'Some plugin instances failed to start')
      return this.list()
    })
  }

  private dependentClosure(initial: ReadonlySet<string>): Set<string> {
    const affected = new Set(initial)
    let changed = true
    while (changed) {
      changed = false
      for (const [instanceId, dependencies] of this.plan?.dependencies ?? []) {
        if (affected.has(instanceId) || !this.active(this.record(instanceId))) continue
        const stops = dependencies.required.some(provider => affected.has(provider))
          || this.record(instanceId).plugin.manifest.lifecycle?.optionalDependencyFailure === 'stop' && dependencies.optional.some(provider => affected.has(provider))
        if (stops) {
          affected.add(instanceId)
          changed = true
        }
      }
    }
    return affected
  }

  private async stopRecord(record: InstanceRecord, reasons: readonly string[] = [], failure?: unknown): Promise<void> {
    if (!record.handle) {
      if (record.state !== 'stopped') this.transition(record, 'stopped', reasons)
      return
    }
    this.transition(record, 'stopping', reasons)
    const handle = record.handle
    record.handle = undefined
    try {
      await handle.dispose()
      if (failure !== undefined) record.error = message(failure)
      this.transition(record, failure === undefined ? 'stopped' : 'failed', reasons)
    } catch (error) {
      record.error = message(error)
      this.transition(record, 'failed', reasons)
      throw new LoaderError('PLUGIN_STOP_FAILED', `Cleanup failed for ${record.plugin.identity.instanceId}`, { cause: error })
    }
  }

  private async stopAffected(affected: ReadonlySet<string>, reason: string, failedInstance?: string, failure?: unknown): Promise<void> {
    const order = this.plan?.order ?? [...this.records.keys()]
    const errors: unknown[] = []
    for (const instanceId of [...order].reverse()) {
      if (!affected.has(instanceId)) continue
      try {
        await this.stopRecord(this.record(instanceId), [reason], instanceId === failedInstance ? failure : undefined)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failures')
  }

  private async reconcile(): Promise<void> {
    if (!this.plan) return
    const unavailable = new Set<string>()
    for (const record of this.records.values()) {
      if (!this.active(record)) continue
      if (this.dependencyIssues(record, 'required').length
        || record.plugin.manifest.lifecycle?.optionalDependencyFailure === 'stop' && this.dependencyIssues(record, 'optional').length) {
        unavailable.add(record.plugin.identity.instanceId)
      }
    }
    try {
      await this.stopAffected(this.dependentClosure(unavailable), 'dependency-unavailable')
    } finally {
      for (const record of this.records.values()) this.refresh(record)
    }
  }

  stop(instanceId: string): Promise<PluginStatus> {
    return this.enqueue(async () => {
      this.assertOpen()
      this.record(instanceId)
      try {
        await this.stopAffected(this.dependentClosure(new Set([instanceId])), `stopped:${instanceId}`)
      } finally {
        await this.reconcile()
      }
      return this.status(instanceId)
    })
  }

  reportFailure(instanceId: string, error: unknown): Promise<PluginStatus> {
    return this.enqueue(async () => {
      this.assertOpen()
      if (!this.active(this.record(instanceId))) throw new LoaderError('INVALID_LIFECYCLE_STATE', 'Only active instances can report a runtime failure')
      this.record(instanceId).restartDependents = new Set([...this.dependentClosure(new Set([instanceId]))].filter(id => this.active(this.record(id))))
      try {
        await this.stopAffected(this.dependentClosure(new Set([instanceId])), `failed:${instanceId}`, instanceId, error ?? new Error('Runtime failure'))
      } finally {
        await this.reconcile()
      }
      return this.status(instanceId)
    })
  }

  retry(instanceId: string, restoreDependents = false): Promise<PluginStatus> {
    return this.enqueue(async () => {
      this.assertOpen()
      const record = this.record(instanceId)
      const policy = record.plugin.manifest.lifecycle?.restart
      if (record.state !== 'failed' || !policy?.enabled) throw new LoaderError('INVALID_LIFECYCLE_STATE', 'Retry requires a failed instance with an enabled restart policy')
      const limit = policy.maxAttempts ?? 3
      if (record.restartAttempts >= limit) {
        this.transition(record, 'quarantined', ['restart-limit'])
        throw new LoaderError('PLUGIN_START_FAILED', `Restart limit reached: ${instanceId}`)
      }
      record.restartAttempts += 1
      const multiplier = policy.backoff === 'linear' ? record.restartAttempts : policy.backoff === 'exponential' ? 2 ** (record.restartAttempts - 1) : 1
      const delay = Math.min((policy.delayMs ?? 1000) * multiplier, policy.maxDelayMs ?? 30000)
      await setTimeout(delay, undefined, { signal: this.cancel.signal })
      this.assertOpen()
      try {
        await this.startRecord(record, true)
        for (const id of this.plan!.order.filter(id => restoreDependents && id !== instanceId && record.restartDependents?.has(id))) {
          const dependent = this.record(id)
          if (dependent.state === 'failed') this.transition(dependent, 'stopped')
          await this.startRecord(dependent)
        }
        record.restartDependents = undefined
      } catch (error) {
        if (record.restartAttempts >= limit) this.transition(record, 'quarantined', ['restart-limit'])
        throw error
      }
      await this.reconcile()
      return this.snapshot(record)
    })
  }

  setCapabilityAvailability(id: string, available: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen()
      const capability = this.capabilities.get(id)
      if (!capability) throw new LoaderError('DEPENDENCY_NOT_FOUND', `Unknown host capability: ${id}`)
      this.capabilities.set(id, Object.freeze({ ...capability, available }))
      await this.reconcile()
    })
  }

  async idle(): Promise<void> {
    let observed: Promise<void>
    do {
      observed = this.tail
      await observed
    } while (observed !== this.tail)
  }

  stopAll(): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen()
      await this.stopAffected(new Set(this.records.keys()), 'shutdown')
    })
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.cancel.abort()
      this.disposal = this.enqueue(async () => {
        const errors: unknown[] = []
        try {
          for (const action of [() => this.unsubscribeServices(), () => this.stopAffected(new Set(this.records.keys()), 'shutdown')]) {
            try {
              await action()
            } catch (error) {
              errors.push(error)
            }
          }
        } finally {
          this.observers.clear()
          if (!this.options.runtime) {
            try {
              await this.runtime.dispose()
            } catch (error) {
              errors.push(error)
            }
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Loader disposal failures')
      })
    }
    return this.disposal
  }
}

export function createPluginLoader(options: LoaderOptions = {}): PluginLoader {
  return new PluginLoader(options)
}
