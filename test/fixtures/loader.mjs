import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { createPluginLoader } from '../../packages/loader/dist/index.js'

export const service = { id: 'example.value', version: '1.0.0' }
export const permission = { id: 'service:example.value' }
export const logger = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map(level => [level, () => {}]))
export const providerCode = `
export function apply(context) {
  context.services.provide(${JSON.stringify(service)}, { read: () => 42 })
  context.lifecycle.add(() => context.logger.info('provider-stopped'))
  return () => context.logger.info('provider-disposer')
}
`
export const consumerCode = `
export function apply(context, config) {
  const value = context.services.require(${JSON.stringify(service)}).read()
  context.logger.info('consumer-started', { value, config })
  return () => context.logger.info('consumer-stopped')
}
`

export async function harness(context, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'easybot-loader-'))
  const loader = createPluginLoader({ baseDirectory: directory, logger, ...options })
  context.after(async () => {
    try {
      await loader.dispose().catch(() => {})
    } finally {
      const target = resolve(directory)
      assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}easybot-loader-`))
      await rm(target, { recursive: true, force: true })
    }
  })
  return { directory, loader }
}

export async function plugin(directory, id, { manifest = {}, code = 'export function apply() {}', version = '1.0.0', packageName = `@example/${id}`, path = id, files = {} } = {}) {
  const root = join(directory, path)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: packageName, version, type: 'module', exports: './index.js' }))
  await writeFile(join(root, 'plugin.json'), JSON.stringify({ schemaVersion: 1, pluginId: `example.${id}`, displayName: id, runtime: { kind: 'in-process', entry: './index.js' }, ...manifest }))
  await writeFile(join(root, 'index.js'), code)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return { instanceId: id, source: { kind: 'local', path: root }, trust: 'trusted' }
}

export async function pair(directory, loader, providerManifest = {}, consumerManifest = {}, code = providerCode) {
  const provider = await plugin(directory, 'provider', { code, manifest: { provides: { services: [service] }, ...providerManifest } })
  const consumer = await plugin(directory, 'consumer', { code: consumerCode, manifest: { requires: { services: { required: [{ id: service.id, version: '^1.0.0' }] } }, permissions: [permission], ...consumerManifest } })
  consumer.policy = [permission]
  consumer.grants = [{ ...permission, instanceId: 'consumer' }]
  await loader.discover(consumer)
  await loader.discover(provider)
  return { provider, consumer }
}

export function codeIs(code) {
  return error => error.code === code
}
