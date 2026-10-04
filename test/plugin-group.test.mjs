import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { writeFile, readFile } from 'node:fs/promises'
import { harness, plugin, logger } from './fixtures/loader.mjs'
import { StateStore } from '../packages/state/dist/index.js'
import { PackageInstaller, PluginGroupManager } from '../packages/plugin-group/dist/index.js'

const manifest = version => ({ schemaVersion: 1, groupId: 'test-group', displayName: 'Test group', version, members: [{ pluginId: 'example.unit', packageName: '@example/unit', version: '^1.0.0', instanceId: 'unit' }] })

async function setup(context) {
  const cleanup = []
  const { directory } = await harness({ after(action) { cleanup.push(action) } })
  const store = new StateStore(join(directory, 'state.sqlite'))
  const installer = new PackageInstaller({ root: join(directory, 'deployments') })
  const manager = new PluginGroupManager({ store, installer, loader: { logger } })
  context.after(async () => { try { await manager.dispose() } finally { store.close(); for (const action of cleanup) await action() } })
  return { directory, store, installer, manager }
}

test('group snapshots source, upgrades as a unit and rolls back to a locked previous deployment', async context => {
  const { directory, manager } = await setup(context)
  const first = await plugin(directory, 'unit', { path: 'first', code: 'export function apply() {}' })
  const second = await plugin(directory, 'unit', { path: 'second', code: 'export function apply() {}' })
  let record = await manager.deploy(manifest('1.0.0'), { unit: first })
  assert.equal(record.state, 'stable')
  assert.equal(manager.runtime('test-group').status('unit').state, 'running')
  await writeFile(join(first.source.path, 'index.js'), "throw new Error('source-mutated')")
  record = await manager.deploy(manifest('1.1.0'), { unit: second })
  assert.equal(record.previous.manifest.version, '1.0.0')
  record = await manager.rollback('test-group')
  assert.equal(record.active.manifest.version, '1.0.0')
  assert.equal(manager.runtime('test-group').status('unit').state, 'running')
  const locked = record.active.members[0]
  assert.notEqual(locked.snapshot.directory, first.source.path)
  assert.match(await readFile(join(locked.snapshot.directory, 'index.js'), 'utf8'), /export function/)
})

test('failed deployment restores old runtime while schema/graph failures never stop it', async context => {
  const { directory, manager } = await setup(context)
  const first = await plugin(directory, 'unit', { path: 'good' })
  await manager.deploy(manifest('1.0.0'), { unit: first })
  const bad = await plugin(directory, 'unit', { path: 'bad', code: "export function apply() { throw new Error('activation-failure') }" })
  await assert.rejects(manager.deploy(manifest('1.1.0'), { unit: bad }), /previous deployment restored/)
  assert.equal(manager.get('test-group').active.manifest.version, '1.0.0')
  assert.equal(manager.runtime('test-group').status('unit').state, 'running')
  const unresolved = await plugin(directory, 'unit', { path: 'unresolved', manifest: { requires: { plugins: { required: [{ pluginId: 'example.missing', version: '*' }] } } } })
  await assert.rejects(manager.deploy(manifest('1.2.0'), { unit: unresolved }), { code: 'DEPENDENCY_NOT_FOUND' })
  assert.equal(manager.runtime('test-group').status('unit').state, 'running')
})

test('deployment restart recovers committed state and ignores an interrupted candidate', async context => {
  const { directory, manager, installer, store } = await setup(context)
  const first = await plugin(directory, 'unit')
  await manager.deploy(manifest('1.0.0'), { unit: first })
  await manager.dispose()
  const stored = store.get('groups', 'test-group')
  store.put('groups', 'test-group', { ...stored.value, state: 'applying', pending: { ...stored.value.active, manifest: manifest('2.0.0') } }, stored.revision)
  const recovered = new PluginGroupManager({ store, installer, loader: { logger } })
  try {
    await recovered.restore()
    assert.equal(recovered.get('test-group').state, 'stable')
    assert.equal(recovered.get('test-group').active.manifest.version, '1.0.0')
    assert.equal(recovered.runtime('test-group').status('unit').state, 'running')
    await recovered.stop('test-group')
    assert.equal(recovered.get('test-group').enabled, false)
  } finally { await recovered.dispose() }
})

test('integrity tampering prevents restore and unsafe npm selectors are rejected', async context => {
  const { directory, manager, installer, store } = await setup(context)
  await manager.deploy(manifest('1.0.0'), { unit: await plugin(directory, 'unit') })
  const snapshot = manager.get('test-group').active.members[0].snapshot
  await writeFile(join(snapshot.directory, 'index.js'), 'export function apply() { return undefined }')
  await assert.rejects(installer.verify(snapshot), /integrity mismatch/)
  await manager.dispose()
  const recovered = new PluginGroupManager({ store, installer })
  try { await assert.rejects(recovered.restore(), /integrity mismatch/) } finally { await recovered.dispose() }
  for (const source of [{ kind: 'npm', packageName: 'https://example.test/plugin.tgz' }, { kind: 'npm', packageName: '--ignore-scripts=false' }, { kind: 'npm', packageName: 'safe', version: 'git+https://example.test/project' }, { kind: 'git', url: 'test' }]) await assert.rejects(installer.snapshot(source), { code: 'INVALID_MANIFEST' })
})

test('rollback failure is durable and does not pretend to undo external side effects', async context => {
  const { directory, manager } = await setup(context)
  const marker = join(directory, 'irreversible-marker')
  const first = await plugin(directory, 'unit', { path: 'old', code: `import { existsSync } from 'node:fs'; export function apply() { if (existsSync(${JSON.stringify(marker)})) throw new Error('old-cannot-recover') }` })
  await manager.deploy(manifest('1.0.0'), { unit: first })
  const second = await plugin(directory, 'unit', { path: 'new', code: `import { writeFileSync } from 'node:fs'; export function apply() { writeFileSync(${JSON.stringify(marker)}, 'side-effect'); throw new Error('new-failed') }` })
  await assert.rejects(manager.deploy(manifest('1.1.0'), { unit: second }), /Deployment and rollback failed/)
  assert.equal(manager.get('test-group').state, 'rollback-failed')
  assert.equal(await readFile(marker, 'utf8'), 'side-effect')
})
