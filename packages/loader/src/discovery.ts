import { readFile, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { JsonObject } from '@easybot/contracts'
import { satisfies, valid, validRange } from 'semver'
import { LoaderError } from './errors.js'
import type { DiscoverOptions, DiscoveredPlugin, PluginSource } from './types.js'
import { createValidator, parseConfig, parseManifest } from './validation.js'

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

export async function packageFile(directory: string, path: string): Promise<string> {
  const candidate = resolve(directory, path)
  const delta = relative(directory, candidate)
  if (isAbsolute(path) || delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw new LoaderError('INVALID_MANIFEST', `Path escapes plugin package: ${path}`)
  }
  const resolved = await realpath(candidate)
  const resolvedDelta = relative(directory, resolved)
  if (resolvedDelta === '..' || resolvedDelta.startsWith(`..${sep}`) || isAbsolute(resolvedDelta)) {
    throw new LoaderError('INVALID_MANIFEST', `Symlink escapes plugin package: ${path}`)
  }
  if (!(await stat(resolved)).isFile()) throw new LoaderError('INVALID_MANIFEST', `Expected a package file: ${path}`)
  return resolved
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function sourceDirectory(source: PluginSource, baseDirectory: string): Promise<string> {
  if (source.kind === 'local') return realpath(resolve(baseDirectory, source.path))
  if (source.kind !== 'npm' || !packageNamePattern.test(source.packageName) || source.packageName.length > 214) {
    throw new LoaderError('INVALID_MANIFEST', 'Only local directories and valid npm package names are supported')
  }
  if (source.version !== undefined && !validRange(source.version)) {
    throw new LoaderError('INVALID_MANIFEST', `Invalid npm version range: ${source.version}`)
  }
  const require = createRequire(join(baseDirectory, 'package.json'))
  for (const search of require.resolve.paths(source.packageName) ?? []) {
    const candidate = join(search, source.packageName)
    try {
      return await realpath(candidate)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }
  throw new LoaderError('DEPENDENCY_NOT_FOUND', `npm package is not installed: ${source.packageName}`)
}

export async function discoverPlugin(input: DiscoverOptions, baseDirectory: string): Promise<DiscoveredPlugin> {
  const options = structuredClone({ ...input, config: parseConfig(input.config ?? {}) })
  if (typeof options.instanceId !== 'string' || !options.instanceId.trim()) throw new LoaderError('INVALID_MANIFEST', 'Instance ID cannot be empty')
  if (!['trusted', 'isolated', 'privileged'].includes(options.trust)) throw new LoaderError('INVALID_MANIFEST', 'Explicit trust selection is required')
  try {
    const directory = await sourceDirectory(options.source, resolve(baseDirectory))
    const packageJson = await readJson(await packageFile(directory, 'package.json'))
    if (typeof packageJson !== 'object' || packageJson === null || !('name' in packageJson) || !('version' in packageJson)
      || typeof packageJson.name !== 'string' || !packageNamePattern.test(packageJson.name)
      || typeof packageJson.version !== 'string' || !valid(packageJson.version)) {
      throw new LoaderError('INVALID_MANIFEST', 'package.json requires a valid npm name and SemVer version')
    }
    if (options.source.kind === 'npm') {
      if (packageJson.name !== options.source.packageName) throw new LoaderError('MANIFEST_MISMATCH', 'Installed npm package name differs from source')
      if (options.source.version && !satisfies(packageJson.version, options.source.version)) {
        throw new LoaderError('VERSION_MISMATCH', `Installed ${packageJson.name}@${packageJson.version} does not satisfy ${options.source.version}`)
      }
    }
    const manifest = parseManifest(await readJson(await packageFile(directory, 'plugin.json')))
    const entry = await packageFile(directory, manifest.runtime.entry)
    if (!/\.(?:mjs|cjs|js)$/.test(entry)) throw new LoaderError('INVALID_MANIFEST', 'Build the plugin entry to JavaScript before loading')
    if (manifest.runtime.kind === 'in-process' && options.trust === 'isolated') {
      throw new LoaderError('PERMISSION_DENIED', 'Isolated plugins cannot run in process')
    }
    const config: JsonObject = parseConfig(options.config ?? {})
    let configSchema: object | boolean | undefined
    if (manifest.config) {
      try {
        const schema = await readJson(await packageFile(directory, manifest.config.schema))
        if (typeof schema !== 'boolean' && (typeof schema !== 'object' || schema === null || Array.isArray(schema))) throw new LoaderError('INVALID_CONFIG', 'Invalid configuration schema')
        const validator = createValidator()
        const validate = validator.compile(schema)
        if (!validate(config)) throw new LoaderError('INVALID_CONFIG', validator.errorsText(validate.errors))
        configSchema = schema
      } catch (error) {
        if (error instanceof LoaderError) throw error
        throw new LoaderError('INVALID_CONFIG', 'Cannot read or compile the configuration schema', { cause: error })
      }
    }
    const identity = Object.freeze({ pluginId: manifest.pluginId, packageName: packageJson.name, version: packageJson.version, instanceId: options.instanceId, ...(options.groupId ? { groupId: options.groupId } : {}) })
    return Object.freeze({ identity, manifest, source: Object.freeze({ ...options.source }), directory, entry, config, ...(configSchema === undefined ? {} : { configSchema }) })
  } catch (error) {
    if (error instanceof LoaderError) throw error
    throw new LoaderError('INVALID_MANIFEST', `Cannot discover plugin instance ${options.instanceId}`, { cause: error })
  }
}
