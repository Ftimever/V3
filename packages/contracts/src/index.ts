import type { WirePluginManifest } from './plugin-manifest.v1.js'
import type { WirePluginGroupManifest } from './plugin-group.v1.js'
import type { Error as WireRpcError } from './rpc-envelope.v1.js'

type ReadonlyDepth = [never, 0, 1, 2, 3, 4, 5, 6]
export type DeepReadonly<Value, Depth extends number = 7> = Depth extends 0
  ? Value
  : Value extends object
  ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key], ReadonlyDepth[Depth]> }
  : Value

export type SemVer = string
export type SemVerRange = string

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
export interface JsonObject {
  readonly [key: string]: JsonValue
}

export type PluginId = string
export type PluginPackageName = string
export type PluginInstanceId = string
export type PluginGroupId = string

export interface PluginIdentity {
  readonly pluginId: PluginId
  readonly packageName: PluginPackageName
  readonly version: SemVer
  readonly instanceId: PluginInstanceId
  readonly groupId?: PluginGroupId
}

export type PluginRuntimeKind = 'in-process' | 'child-process'
export type PluginTrustLevel = 'trusted' | 'isolated' | 'privileged'

export interface PluginRuntime {
  readonly kind: PluginRuntimeKind
  readonly entry: string
  readonly protocolVersion?: number
}

export interface PluginRuntimeSelection extends PluginRuntime {
  readonly trust: PluginTrustLevel
}

export type CapabilityId = string

export interface ServiceReference {
  readonly id: string
  readonly version: SemVer
  readonly methods?: readonly string[]
}

export interface EventReference {
  readonly id: string
  readonly version: SemVer
}

export interface PluginDependency {
  readonly pluginId: PluginId
  readonly version: SemVerRange
}

export interface ServiceDependency {
  readonly id: string
  readonly version: SemVerRange
}

export interface CapabilityDependency {
  readonly id: CapabilityId
  readonly version?: SemVerRange
}

export interface DependencySet<T> {
  readonly required?: readonly T[]
  readonly optional?: readonly T[]
}

export interface PluginRequirements {
  readonly plugins?: DependencySet<PluginDependency>
  readonly services?: DependencySet<ServiceDependency>
  readonly capabilities?: DependencySet<CapabilityDependency>
}

export type PermissionCategory =
  | 'process'
  | 'network'
  | 'filesystem'
  | 'storage'
  | 'service'
  | 'event'
  | 'webui'
  | 'secret'

export type PermissionId = `${PermissionCategory}:${string}`

export interface PermissionRequest {
  readonly id: PermissionId
  readonly reason?: string
  readonly scope?: JsonObject
}

export interface PermissionGrant {
  readonly instanceId: PluginInstanceId
  readonly id: PermissionId
  readonly scope?: JsonObject
}

export type PluginLifecycleState =
  | 'discovered'
  | 'resolved'
  | 'starting'
  | 'ready'
  | 'running'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'quarantined'

export type FailureDependencyPolicy = 'stop' | 'degraded'

export interface RestartPolicy {
  readonly enabled: boolean
  readonly maxAttempts?: number
  readonly backoff?: 'fixed' | 'linear' | 'exponential'
  readonly delayMs?: number
  readonly maxDelayMs?: number
}

export interface PluginFailurePolicy {
  readonly restart?: RestartPolicy
  readonly requiredDependencyFailure?: FailureDependencyPolicy
  readonly optionalDependencyFailure?: FailureDependencyPolicy
}

export type ConfigReloadPolicy = 'hot' | 'reconnect' | 'restart' | 'manual'

export interface ConfigPropertyMetadata {
  readonly 'x-reload'?: ConfigReloadPolicy
}

export interface ConfigSchemaReference {
  readonly schema: string
  readonly properties?: Readonly<Record<string, ConfigPropertyMetadata>>
}

export interface WebUiNavigationItem {
  readonly id: string
  readonly label: string
  readonly route: string
  readonly icon?: string
}

export type WebUiCardComponent = 'status-card' | 'log-panel' | 'info-card'

export interface WebUiCard {
  readonly id: string
  readonly component: WebUiCardComponent
  readonly title?: string
  readonly props?: JsonObject
}

export interface WebUiManifest {
  readonly navigation?: readonly WebUiNavigationItem[]
  readonly config?: ConfigSchemaReference
  readonly cards?: readonly WebUiCard[]
}

export type PluginManifest = DeepReadonly<Omit<WirePluginManifest, 'permissions'> & {
  permissions?: readonly PermissionRequest[]
}>

export interface ServiceToken<TService = unknown> extends ServiceReference {
  readonly service?: TService
}

export type ServiceReadiness = 'unavailable' | 'ready' | 'degraded'

export interface EventDescriptor<TPayload = unknown> extends EventReference {
  readonly payload?: TPayload
}

export type EventDelivery = 'parallel' | 'serial' | 'pipeline'

export interface EventDefinition<TPayload = unknown> extends EventDescriptor<TPayload> {
  readonly delivery?: EventDelivery
  readonly retryable?: boolean
}

export interface EventMiddlewareOrdering {
  readonly before?: readonly PluginId[]
  readonly after?: readonly PluginId[]
}

export type PipelineResult<TValue> =
  | { readonly action: 'continue'; readonly value: TValue }
  | { readonly action: 'stop'; readonly reason: string }
  | { readonly action: 'retry'; readonly delayMs: number; readonly reason?: string }

export type EventListener<TPayload> = (
  payload: Readonly<TPayload>,
) => void | Promise<void>

export type EventMiddleware<TPayload> = (
  payload: Readonly<TPayload>,
) => PipelineResult<TPayload> | Promise<PipelineResult<TPayload>>

export interface PluginGroupMember {
  readonly pluginId: PluginId
  readonly packageName: PluginPackageName
  readonly version: SemVerRange
  readonly instanceId: PluginInstanceId
  readonly runtime?: PluginRuntimeSelection
}

export interface ServiceBinding {
  readonly implementation: PluginInstanceId
  readonly allowOverride?: boolean
}

export type PluginGroupManifest = DeepReadonly<Omit<WirePluginGroupManifest, 'permissions'> & {
  permissions?: readonly PermissionGrant[]
}>

export type PlatformErrorCode = WireRpcError['code']

export type RpcErrorCode = PlatformErrorCode

export interface PlatformError {
  readonly code: PlatformErrorCode
  readonly message: string
  readonly data?: JsonValue
}

export interface RpcError {
  readonly code: RpcErrorCode
  readonly message: string
  readonly data?: JsonValue
}

export interface RpcEnvelopeBase {
  readonly protocol: 'easybot.rpc'
  readonly version: 1
  readonly pluginInstanceId?: PluginInstanceId
  readonly traceId?: string
  readonly deadline?: number
  readonly capability?: CapabilityId
}

export interface RpcRequest<TPayload extends JsonValue = JsonValue> extends RpcEnvelopeBase {
  readonly type: 'request'
  readonly id: string
  readonly method: string
  readonly payload?: TPayload
}

export interface RpcResponse<TPayload extends JsonValue = JsonValue> extends RpcEnvelopeBase {
  readonly type: 'response'
  readonly id: string
  readonly ok: true
  readonly payload?: TPayload
}

export interface RpcErrorResponse extends RpcEnvelopeBase {
  readonly type: 'response'
  readonly id: string
  readonly ok: false
  readonly error: RpcError
}

export interface RpcNotification<TPayload extends JsonValue = JsonValue> extends RpcEnvelopeBase {
  readonly type: 'notification'
  readonly method: string
  readonly payload?: TPayload
}

export type RpcStreamPhase = 'open' | 'chunk' | 'close'

export interface RpcStream<TPayload extends JsonValue = JsonValue> extends RpcEnvelopeBase {
  readonly type: 'stream'
  readonly id: string
  readonly stream: RpcStreamPhase
  readonly payload?: TPayload
  readonly error?: RpcError
}

export interface RpcCancel extends RpcEnvelopeBase {
  readonly type: 'cancel'
  readonly id: string
  readonly reason?: string
}

export interface RpcCapabilities {
  readonly services?: readonly ServiceReference[]
  readonly events?: readonly EventReference[]
  readonly capabilities?: readonly CapabilityId[]
  readonly features?: readonly string[]
}

export interface RpcHello extends RpcEnvelopeBase {
  readonly type: 'hello'
  readonly capabilities: RpcCapabilities
}

export interface RpcHelloAck extends RpcEnvelopeBase {
  readonly type: 'hello-ack'
  readonly capabilities: RpcCapabilities
}

export type RpcEnvelope<TPayload extends JsonValue = JsonValue> =
  | RpcRequest<TPayload>
  | RpcResponse<TPayload>
  | RpcErrorResponse
  | RpcNotification<TPayload>
  | RpcStream<TPayload>
  | RpcCancel
  | RpcHello
  | RpcHelloAck

export type Dispose = () => void | Promise<void>

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type LogFields = Readonly<Record<string, unknown>>

export interface Logger {
  trace(message: string, fields?: LogFields): void
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  fatal(message: string, fields?: LogFields): void
}

export interface ServiceAccess {
  require<TService>(token: ServiceToken<TService>): TService
  get<TService>(token: ServiceToken<TService>): TService | undefined
  provide<TService>(token: ServiceToken<TService>, service: TService, readiness?: ServiceReadiness): ServiceRegistration
  provideScoped<TService>(token: ServiceToken<TService>, factory: (requester: PluginContext) => TService, readiness?: ServiceReadiness): ServiceRegistration
  readiness<TService>(token: ServiceToken<TService>): ServiceReadiness | undefined
}

export interface ServiceRegistration {
  setReadiness(state: ServiceReadiness): void
  readonly dispose: Dispose
}

export interface EventAccess {
  on<TPayload>(event: EventDefinition<TPayload>, listener: EventListener<TPayload>): Dispose
  emit<TPayload>(event: EventDefinition<TPayload>, payload: TPayload): Promise<PipelineResult<TPayload>>
  use<TPayload>(event: EventDefinition<TPayload>, id: string, middleware: EventMiddleware<TPayload>, ordering?: EventMiddlewareOrdering): Dispose
}

export interface EventPipeline {
  use<TPayload>(
    event: EventDefinition<TPayload>,
    middleware: EventMiddleware<TPayload>,
    ordering?: EventMiddlewareOrdering,
  ): Dispose
  run<TPayload>(event: EventDefinition<TPayload>, payload: TPayload): Promise<PipelineResult<TPayload>>
}

export interface LifecycleScope {
  readonly disposed: boolean
  add(dispose: Dispose): Dispose
  dispose(): Promise<void>
  assertActive(): void
}

export interface CapabilityAccess {
  require(permission: PermissionId, target?: JsonObject): void
}

export interface PluginContext {
  readonly plugin: PluginIdentity
  readonly services: ServiceAccess
  readonly events: EventAccess
  readonly lifecycle: LifecycleScope
  readonly capabilities: CapabilityAccess
  readonly logger: Logger
}

export interface PluginDefinition<TConfig = JsonObject> {
  readonly manifest: PluginManifest
  readonly apply: (
    context: PluginContext,
    config: Readonly<TConfig>,
  ) => void | Dispose | Promise<void | Dispose>
  readonly reconfigure?: (
    context: PluginContext,
    config: Readonly<TConfig>,
    previousConfig: Readonly<TConfig>,
  ) => void | Promise<void>
}
export { snapshotJson } from './json.js'
