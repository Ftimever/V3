import Ajv2020 from 'ajv/dist/2020.js'
import type { PluginManifest, PluginContext, PluginDefinition, PluginIdentity } from '@easybot/contracts'
import { pluginManifestSchema } from '@easybot/contracts/schemas'

export interface ContractFailure { readonly code: string; readonly message: string }
export interface ManifestContractResult { readonly valid: boolean; readonly failures: readonly ContractFailure[] }
export interface PluginContractInput { readonly manifest: unknown; readonly identity?: Partial<PluginIdentity> }

const validate = new Ajv2020({ allErrors: true, strictRequired: false }).compile(pluginManifestSchema)

export function checkPluginManifest(input: PluginContractInput): ManifestContractResult {
  const failures: ContractFailure[] = []
  if (!validate(input.manifest)) for (const error of validate.errors ?? []) failures.push({ code: 'MANIFEST_SCHEMA', message: `${error.instancePath || '/'} ${error.message ?? 'invalid'}` })
  const manifest = input.manifest as Partial<PluginManifest>
  if (input.identity?.pluginId && input.identity.pluginId !== manifest.pluginId) failures.push({ code: 'IDENTITY_MISMATCH', message: 'identity.pluginId must equal manifest.pluginId' })
  if (manifest.runtime?.kind === 'child-process' && !manifest.runtime.protocolVersion) failures.push({ code: 'PROTOCOL_REQUIRED', message: 'child-process plugins require runtime.protocolVersion' })
  return Object.freeze({ valid: failures.length === 0, failures: Object.freeze(failures) })
}

export function assertPluginManifest(input: PluginContractInput): asserts input is PluginContractInput & { manifest: PluginManifest } {
  const result = checkPluginManifest(input)
  if (!result.valid) throw new TypeError(result.failures.map(failure => `${failure.code}: ${failure.message}`).join('; '))
}

export interface LifecycleContractOptions {
  readonly createContext: () => PluginContext
  readonly definition: PluginDefinition
}

export async function assertPluginLifecycle(options: LifecycleContractOptions): Promise<void> {
  const context = options.createContext()
  const cleanup = await options.definition.apply(context, {})
  if (cleanup !== undefined && typeof cleanup !== 'function') throw new TypeError('Plugin apply must return void or a disposer')
  await context.lifecycle.dispose()
  if (cleanup) await cleanup()
}
