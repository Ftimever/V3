import { isDeepStrictEqual } from 'node:util'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import type { ConfigReloadPolicy, JsonObject, JsonValue } from '@easybot/contracts'
import { StateStore } from '@easybot/state'

export type ApplyState = 'saved' | 'pending' | 'applying' | 'applied' | 'apply-failed' | 'rollback-failed'
export interface ConfigSnapshot {
  readonly revision: number
  readonly savedVersion: number
  readonly runningVersion: number
  readonly saved: JsonObject
  readonly running: JsonObject
  readonly state: ApplyState
  readonly error?: string
}

interface ConfigRecord {
  savedVersion: number
  runningVersion: number
  saved: JsonObject
  running: JsonObject
  state: ApplyState
  error?: string
}

export interface ConfigRegistration {
  readonly schema: object | boolean
  readonly initial?: JsonObject
  readonly reload?: Readonly<Record<string, ConfigReloadPolicy>>
  readonly apply: (next: JsonObject, previous: JsonObject, policy: ConfigReloadPolicy) => Promise<void>
}

export class ConfigError extends Error {
  constructor(readonly code: 'INVALID_CONFIG' | 'VERSION_MISMATCH' | 'PLUGIN_UNAVAILABLE', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConfigError'
  }
}

function jsonObject(value: unknown): JsonObject {
  const visit = (item: unknown, ancestors: Set<object>): JsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || item === null || ancestors.has(item)) throw new ConfigError('INVALID_CONFIG', 'Configuration must contain finite, acyclic JSON values')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new ConfigError('INVALID_CONFIG', 'Configuration requires plain objects')
    ancestors.add(item)
    const output = Array.isArray(item) ? Array.from(item, child => visit(child, ancestors)) : Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, ancestors)]))
    ancestors.delete(item)
    return Object.freeze(output)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ConfigError('INVALID_CONFIG', 'Configuration must be an object')
  return visit(value, new Set()) as JsonObject
}

export class ConfigManager {
  private readonly registrations = new Map<string, { registration: ConfigRegistration; validate: ValidateFunction }>()
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly store: StateStore) {}

  bind(id: string, registration: ConfigRegistration): ConfigSnapshot {
    this.registrations.delete(id)
    return this.register(id, registration)
  }

  register(id: string, registration: ConfigRegistration): ConfigSnapshot {
    if (this.registrations.has(id)) throw new ConfigError('INVALID_CONFIG', `Duplicate configuration: ${id}`)
    const validate = new Ajv2020({ allErrors: true, allowUnionTypes: true, strictRequired: false }).compile(registration.schema)
    const initial = jsonObject(registration.initial ?? {})
    const existing = this.store.get('config', id)
    if (!existing && !validate(initial)) throw new ConfigError('INVALID_CONFIG', JSON.stringify(validate.errors))
    if (!existing) this.write(id, { savedVersion: 1, runningVersion: 1, saved: initial, running: initial, state: 'applied' }, 0)
    else {
      const record = existing.value as unknown as ConfigRecord
      if (!validate(record.saved) || !validate(record.running)) {
        throw new ConfigError('INVALID_CONFIG', 'Persisted configuration does not match the schema')
      }
      if (record.state === 'applying') this.write(id, { ...record, state: 'apply-failed', error: 'Previous apply was interrupted; runtime must be reconciled' }, existing.revision)
    }
    this.registrations.set(id, { registration: Object.freeze({ ...registration, reload: Object.freeze({ ...registration.reload }) }), validate })
    return this.get(id)
  }

  get(id: string): ConfigSnapshot {
    const stored = this.store.get('config', id)
    if (!stored) throw new ConfigError('PLUGIN_UNAVAILABLE', `Unknown configuration: ${id}`)
    const record = stored.value as unknown as ConfigRecord
    return Object.freeze({ ...record, saved: jsonObject(record.saved), running: jsonObject(record.running), revision: stored.revision })
  }

  private write(id: string, value: ConfigRecord, revision: number): void {
    const { savedVersion, runningVersion, saved, running, state, error } = value
    this.store.put('config', id, { savedVersion, runningVersion, saved, running, state, ...(error === undefined ? {} : { error }) }, revision)
  }

  private enqueue<Result>(id: string, action: () => Promise<Result> | Result): Promise<Result> {
    const result = (this.queues.get(id) ?? Promise.resolve()).then(action)
    this.queues.set(id, result.then(() => {}, () => {}))
    return result
  }

  save(id: string, value: JsonObject, expectedRevision: number): Promise<ConfigSnapshot> {
    let snapshot: JsonObject
    try { snapshot = jsonObject(value) } catch (error) { return Promise.reject(error) }
    return this.enqueue(id, () => {
      const entry = this.registrations.get(id)
      if (!entry) throw new ConfigError('PLUGIN_UNAVAILABLE', id)
      if (!entry.validate(snapshot)) throw new ConfigError('INVALID_CONFIG', JSON.stringify(entry.validate.errors))
      const current = this.get(id)
      if (current.revision !== expectedRevision) throw new ConfigError('VERSION_MISMATCH', 'Configuration revision changed')
      this.write(id, { ...current, savedVersion: current.savedVersion + 1, saved: snapshot, state: 'saved', error: undefined }, expectedRevision)
      return this.get(id)
    })
  }

  apply(id: string, expectedRevision: number, allowManual = false): Promise<ConfigSnapshot> {
    return this.enqueue(id, async () => {
      const entry = this.registrations.get(id)
      if (!entry) throw new ConfigError('PLUGIN_UNAVAILABLE', id)
      const current = this.get(id)
      if (current.revision !== expectedRevision) throw new ConfigError('VERSION_MISMATCH', 'Configuration revision changed')
      const policies = [...new Set([...Object.keys(current.saved), ...Object.keys(current.running)])].filter(key => !isDeepStrictEqual(current.saved[key], current.running[key])).map(key => entry.registration.reload?.[key] ?? 'restart')
      const policy = policies.includes('manual') ? 'manual' : policies.includes('restart') ? 'restart' : policies.includes('reconnect') ? 'reconnect' : 'hot'
      if (!policies.length && current.state === 'applied') return current
      if (policy === 'manual' && !allowManual) {
        this.write(id, { ...current, state: 'pending' }, current.revision)
        return this.get(id)
      }
      this.write(id, { ...current, state: 'applying', error: undefined }, current.revision)
      try {
        await entry.registration.apply(current.saved, current.running, policy === 'manual' ? 'restart' : policy)
      } catch (error) {
        let state: ApplyState = 'apply-failed'
        let cause: unknown = error
        try {
          await entry.registration.apply(current.running, current.saved, policy === 'manual' ? 'restart' : policy)
        } catch (rollbackError) {
          state = 'rollback-failed'
          cause = new AggregateError([error, rollbackError], 'Configuration apply and rollback failed')
        }
        const pending = this.get(id)
        this.write(id, { ...current, state, error: error instanceof Error ? error.message : String(error) }, pending.revision)
        throw new ConfigError('INVALID_CONFIG', state, { cause })
      }
      const pending = this.get(id)
      this.write(id, { ...current, running: current.saved, runningVersion: current.savedVersion, state: 'applied', error: undefined }, pending.revision)
      return this.get(id)
    })
  }
}
