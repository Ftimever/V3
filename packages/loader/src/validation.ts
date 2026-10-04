import type { JsonObject, JsonValue, PluginManifest } from '@easybot/contracts'
import { pluginManifestSchema } from '@easybot/contracts/schemas'
import Ajv2020 from 'ajv/dist/2020.js'
import { valid, validRange } from 'semver'
import { LoaderError } from './errors.js'

export function createValidator(): Ajv2020 {
  return new Ajv2020({ allErrors: true, allowUnionTypes: true, strictRequired: false })
}

const validator = createValidator()
const validateManifest = validator.compile<PluginManifest>(pluginManifestSchema)

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new LoaderError('INVALID_MANIFEST', `Duplicate ${label}`)
}

export function parseManifest(value: unknown): PluginManifest {
  if (!validateManifest(value)) throw new LoaderError('INVALID_MANIFEST', validator.errorsText(validateManifest.errors))
  for (const [kind, references] of Object.entries(value.provides ?? {})) {
    unique(references.map(reference => reference.id), `provided ${kind}`)
    for (const reference of references) {
      if (!valid(reference.version)) throw new LoaderError('INVALID_MANIFEST', `Invalid ${kind} version: ${reference.version}`)
    }
  }
  for (const [kind, dependencies] of Object.entries(value.requires ?? {})) {
    const declarations = [...dependencies.required ?? [], ...dependencies.optional ?? []]
    const ids = declarations.map(dependency => 'pluginId' in dependency ? dependency.pluginId : dependency.id)
    unique(ids, `${kind} dependencies`)
    for (const dependency of declarations) {
      if (dependency.version !== undefined && !validRange(dependency.version)) {
        throw new LoaderError('INVALID_MANIFEST', `Invalid ${kind} version range: ${dependency.version}`)
      }
    }
  }
  unique((value.permissions ?? []).map(permission => permission.id), 'permissions')
  return freezeJson(value) as PluginManifest
}

export function freezeJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || value === null) throw new LoaderError('INVALID_PAYLOAD', 'Expected a finite JSON value')
  if (ancestors.has(value)) throw new LoaderError('INVALID_PAYLOAD', 'Cyclic JSON value')
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new LoaderError('INVALID_PAYLOAD', 'Expected a plain JSON object')
  }
  ancestors.add(value)
  const result = Array.isArray(value)
    ? Array.from(value, item => freezeJson(item, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeJson(item, ancestors)]))
  ancestors.delete(value)
  return Object.freeze(result)
}

export function parseConfig(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LoaderError('INVALID_CONFIG', 'Plugin configuration must be a JSON object')
  }
  try {
    return freezeJson(value) as JsonObject
  } catch (error) {
    throw new LoaderError('INVALID_CONFIG', 'Invalid plugin configuration', { cause: error })
  }
}
