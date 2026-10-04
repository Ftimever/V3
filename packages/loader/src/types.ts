import type { JsonObject, PermissionGrant, PermissionRequest, PluginIdentity, PluginLifecycleState, PluginManifest, PluginTrustLevel } from '@easybot/contracts'
import type { CoreRuntime, RuntimeOptions } from '@easybot/core'

export type PluginSource =
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'npm'; readonly packageName: string; readonly version?: string }

export interface DiscoverOptions {
  readonly instanceId: string
  readonly source: PluginSource
  readonly trust: PluginTrustLevel
  readonly groupId?: string
  readonly config?: JsonObject
  readonly policy?: readonly PermissionRequest[]
  readonly grants?: readonly PermissionGrant[]
}

export interface DiscoveredPlugin {
  readonly identity: PluginIdentity
  readonly manifest: PluginManifest
  readonly source: PluginSource
  readonly directory: string
  readonly entry: string
  readonly config: JsonObject
  readonly configSchema?: object | boolean
}

export interface PluginStatus {
  readonly identity: PluginIdentity
  readonly state: PluginLifecycleState
  readonly restartAttempts: number
  readonly reasons: readonly string[]
  readonly error?: string
}

export interface HostCapability {
  readonly id: string
  readonly version: string
  readonly available?: boolean
}

export interface LoaderOptions extends RuntimeOptions {
  readonly baseDirectory?: string
  readonly runtime?: CoreRuntime
  readonly capabilities?: readonly HostCapability[]
  readonly processStartupTimeoutMs?: number
  readonly processShutdownTimeoutMs?: number
}

export interface DependencyPlan {
  readonly order: readonly string[]
  readonly dependencies: ReadonlyMap<string, InstanceDependencies>
}

export interface InstanceDependencies {
  readonly required: readonly string[]
  readonly optional: readonly string[]
  readonly missingOptional: readonly string[]
}
