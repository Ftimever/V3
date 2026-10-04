export type Json = (string | number | boolean | null) | Json[] | JsonObject

export interface WirePluginGroupManifest {
  $schema?: string
  schemaVersion: 1
  groupId: string
  displayName: string
  version: string
  members: {
    pluginId: string
    packageName: string
    version: string
    instanceId: string
    runtime?: {
      kind: 'in-process' | 'child-process'
      entry: string
      protocolVersion?: number
      trust: 'trusted' | 'isolated' | 'privileged'
    }
  }[]
  serviceBindings?: {
    [k: string]: {
      implementation: string
      allowOverride?: boolean
    }
  }
  permissions?: {
    instanceId: string
    id: string
    scope?: JsonObject
  }[]
}
export interface JsonObject {
  [k: string]: Json
}
