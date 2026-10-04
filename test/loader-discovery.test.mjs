import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { discoverPlugin } from '../packages/loader/dist/index.js'
import { codeIs, harness, plugin, service } from './fixtures/loader.mjs'

test('discovery validates immutable metadata and does not execute the entry', async context => {
  const { directory, loader } = await harness(context)
  const options = await plugin(directory, 'safe', { code: "throw new Error('must-not-execute')" })
  const discovered = await loader.discover(options)
  assert.equal(discovered.identity.packageName, '@example/safe')
  assert.equal(loader.status('safe').state, 'discovered')
  assert.ok(Object.isFrozen(discovered.manifest.runtime))
  await assert.rejects(loader.start('safe'), AggregateError)
  assert.equal(loader.status('safe').state, 'failed')
  assert.match(loader.status('safe').error, /must-not-execute/)
})

test('npm discovery works with scoped packages whose package.json is not exported', async context => {
  const { directory, loader } = await harness(context)
  await plugin(directory, 'npm', { packageName: '@example/npm', path: 'node_modules/@example/npm' })
  const discovered = await loader.discover({ instanceId: 'npm', source: { kind: 'npm', packageName: '@example/npm', version: '^1.0.0' }, trust: 'trusted' })
  assert.equal(discovered.identity.version, '1.0.0')
  await loader.start('npm')
  assert.equal(loader.status('npm').state, 'running')
  await assert.rejects(discoverPlugin({ instanceId: 'mismatch', source: { kind: 'npm', packageName: '@example/npm', version: '^2.0.0' }, trust: 'trusted' }, directory), codeIs('VERSION_MISMATCH'))
})

test('npm sources reject missing packages, selectors and traversal', async context => {
  const { directory } = await harness(context)
  for (const packageName of ['../other', 'https://example.test/plugin', '@example/name@latest', 'file:../plugin']) {
    await assert.rejects(discoverPlugin({ instanceId: 'invalid', source: { kind: 'npm', packageName }, trust: 'trusted' }, directory), codeIs('INVALID_MANIFEST'))
  }
  await assert.rejects(discoverPlugin({ instanceId: 'missing', source: { kind: 'npm', packageName: '@example/not-installed' }, trust: 'trusted' }, directory), codeIs('DEPENDENCY_NOT_FOUND'))
})

test('discovery rejects escaped entries and isolated in-process execution', async context => {
  const { directory, loader } = await harness(context)
  const escaped = await plugin(directory, 'escape', { manifest: { runtime: { kind: 'in-process', entry: './../other.js' } } })
  await writeFile(join(directory, 'other.js'), 'export function apply() {}')
  await assert.rejects(loader.discover(escaped), codeIs('INVALID_MANIFEST'))
  const isolated = await plugin(directory, 'isolated')
  isolated.trust = 'isolated'
  await assert.rejects(loader.discover(isolated), codeIs('PERMISSION_DENIED'))
})

test('realpath confinement rejects directory symlinks outside a package', async context => {
  const { directory, loader } = await harness(context)
  const options = await plugin(directory, 'linked', { manifest: { runtime: { kind: 'in-process', entry: './linked/index.js' } } })
  const external = join(directory, 'external')
  await mkdir(external)
  await writeFile(join(external, 'index.js'), 'export function apply() {}')
  await symlink(external, join(options.source.path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(loader.discover(options), codeIs('INVALID_MANIFEST'))
})

test('configuration schema validates before import and isolates repeated schema IDs', async context => {
  const { directory, loader } = await harness(context)
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:example:config', type: 'object', required: ['count'], additionalProperties: false, properties: { count: { type: 'integer', minimum: 0 } } }
  const options = await plugin(directory, 'configured', { manifest: { config: { schema: './config.schema.json' } }, files: { 'config.schema.json': schema } })
  options.config = { count: -1 }
  await assert.rejects(loader.discover(options), codeIs('INVALID_CONFIG'))
  options.config = { count: 1 }
  const discovered = await loader.discover(options)
  assert.deepEqual(discovered.config, { count: 1 })
  assert.ok(Object.isFrozen(discovered.config))
  const second = await plugin(directory, 'configured-second', { manifest: { config: { schema: './config.schema.json' } }, files: { 'config.schema.json': schema } })
  second.config = { count: 2 }
  await loader.discover(second)
})

test('semantic validation rejects invalid ranges, SemVer versions and duplicate declarations', async context => {
  const { directory, loader } = await harness(context)
  for (const [id, manifest] of [
    ['range', { requires: { plugins: { required: [{ pluginId: 'example.other', version: 'not-semver' }] } } }],
    ['version', { provides: { services: [{ id: 'example.value', version: '01.0.0' }] } }],
    ['duplicate', { provides: { services: [service, service] } }],
    ['duplicate-dependency', { requires: { services: { required: [{ id: service.id, version: '^1.0.0' }], optional: [{ id: service.id, version: '^1.0.0' }] } } }],
  ]) {
    await assert.rejects(loader.discover(await plugin(directory, id, { manifest })), codeIs('INVALID_MANIFEST'))
  }
})

test('duplicate instance IDs and unsupported raw TypeScript entries are rejected', async context => {
  const { directory, loader } = await harness(context)
  const options = await plugin(directory, 'duplicate-id')
  await loader.discover(options)
  await assert.rejects(loader.discover(options), codeIs('INSTANCE_CONFLICT'))
  const typescript = await plugin(directory, 'typescript', { manifest: { runtime: { kind: 'in-process', entry: './index.ts' } }, files: { 'index.ts': 'export function apply() {}' } })
  await assert.rejects(loader.discover(typescript), codeIs('INVALID_MANIFEST'))
})

test('configuration rejects values that do not round-trip through JSON', async context => {
  const { directory, loader } = await harness(context)
  const options = await plugin(directory, 'json')
  for (const value of [NaN, Infinity, undefined, new Date(), Array(1), () => {}]) {
    options.config = { value }
    await assert.rejects(loader.discover(options), codeIs('INVALID_CONFIG'))
  }
  assert.equal(JSON.parse(await readFile(join(options.source.path, 'plugin.json'), 'utf8')).pluginId, 'example.json')
})

test('boolean configuration schemas follow JSON Schema semantics', async context => {
  const { directory, loader } = await harness(context)
  const accepts = await plugin(directory, 'accept-config', { manifest: { config: { schema: './schema.json' } }, files: { 'schema.json': true } })
  accepts.config = { arbitrary: ['json'] }
  await loader.discover(accepts)
  const rejects = await plugin(directory, 'reject-config', { manifest: { config: { schema: './schema.json' } }, files: { 'schema.json': false } })
  await assert.rejects(loader.discover(rejects), codeIs('INVALID_CONFIG'))
})
