export type Json = (string | number | boolean | null) | Json[] | JsonObject

export interface WirePluginManifest {
  $schema?: string
  schemaVersion: 1
  pluginId: string
  displayName: string
  description?: string
  documentation?: string
  runtime: {
    kind: 'in-process' | 'child-process'
    entry: string
    protocolVersion?: number
  }
  provides?: {
    services?: Reference[]
    events?: EventReference[]
  }
  requires?: {
    plugins?: PluginDependencies
    services?: ServiceDependencies
    capabilities?: CapabilityDependencies
  }
  permissions?: Permission[]
  lifecycle?: {
    restart?: {
      enabled: boolean
      maxAttempts?: number
      backoff?: 'fixed' | 'linear' | 'exponential'
      delayMs?: number
      maxDelayMs?: number
    }
    requiredDependencyFailure?: 'stop'
    optionalDependencyFailure?: 'stop' | 'degraded'
  }
  config?: Config
  webui?: {
    navigation?: {
      id: string
      label: string
      route: string
      icon?: string
    }[]
    config?: Config
    cards?: {
      id: string
      component: 'status-card' | 'log-panel' | 'info-card'
      title?: string
      props?: JsonObject
    }[]
  }
}
export interface Reference {
  id: string
  methods?: string[]
  version: string
}
export interface EventReference {
  id: string
  version: string
  delivery?: 'parallel' | 'serial' | 'pipeline'
  retryable?: boolean
}
export interface PluginDependencies {
  required?: PluginDependency[]
  optional?: PluginDependency[]
}
export interface PluginDependency {
  pluginId: string
  version: string
}
export interface ServiceDependencies {
  required?: ServiceDependency[]
  optional?: ServiceDependency[]
}
export interface ServiceDependency {
  id: string
  version: string
}
export interface CapabilityDependencies {
  required?: CapabilityDependency[]
  optional?: CapabilityDependency[]
}
export interface CapabilityDependency {
  id: string
  version?: string
}
export interface Permission {
  id: string
  reason?: string
  scope?: JsonObject
}
export interface JsonObject {
  [k: string]: Json
}
export interface Config {
  schema: string
  properties?: {
    [k: string]: {
      'x-reload'?: 'hot' | 'reconnect' | 'restart' | 'manual'
    }
  }
}
