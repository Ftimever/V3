import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { StateStore, SecretVault } from '../packages/state/dist/index.js'
import { createCoreRuntime } from '../packages/core/dist/index.js'
import { mountBasePlugins, LogBuffer, WebUiRegistry, storage, secrets, http, websocket, webui } from '../packages/base/dist/index.js'
import { randomBytes } from 'node:crypto'

const require = createRequire(new URL('../packages/base/package.json', import.meta.url))
const { WebSocketServer } = require('ws')

async function setup(context, tokens, permissions = [], groupId) {
  const store = new StateStore(':memory:')
  const logs = new LogBuffer(2)
  const ui = new WebUiRegistry()
  const runtime = createCoreRuntime({ logger: logs.logger })
  await mountBasePlugins(runtime, { store, vault: new SecretVault(store, randomBytes(32)), logs, webui: ui }, groupId)
  context.after(async () => { await runtime.dispose(); store.close() })
  const mount = async (id, activate, extraPermissions = permissions) => {
    const declarations = [...tokens.map(token => ({ id: `service:${token.id}` })), ...extraPermissions]
    return runtime.mount({ identity: { pluginId: `example.${id}`, packageName: `@example/${id}`, version: '1.0.0', instanceId: id, ...(groupId ? { groupId } : {}) }, manifest: { schemaVersion: 1, pluginId: `example.${id}`, displayName: id, runtime: { kind: 'in-process', entry: './index.js' }, requires: { services: { required: tokens.map(token => ({ id: token.id, version: '^1.0.0' })) } }, permissions: declarations }, policy: declarations, grants: declarations.map(permission => ({ ...permission, instanceId: id })) }, activate)
  }
  return { runtime, store, logs, ui, mount }
}

test('base storage/secrets bind ownership, CAS and permissions to requester and revoke on stop', async context => {
  const { mount } = await setup(context, [storage, secrets], [{ id: 'storage:own' }, { id: 'secret:own' }])
  let firstStorage
  let firstSecrets
  const first = await mount('one', async plugin => { firstStorage = plugin.services.require(storage); firstSecrets = plugin.services.require(secrets); await firstStorage.put('same', { value: 1 }, 0); await firstSecrets.set('same', 'one-secret') })
  await mount('two', async plugin => {
    assert.equal(await plugin.services.require(storage).get('same'), null)
    assert.equal(await plugin.services.require(secrets).get('same'), null)
    await plugin.services.require(storage).put('same', { value: 2 }, 0)
  })
  assert.equal((await firstStorage.get('same')).value.value, 1)
  await assert.rejects(firstStorage.put('same', null, 0), { code: 'VERSION_MISMATCH' })
  await first.dispose()
  await assert.rejects(firstStorage.get('same'), { code: 'SCOPE_DISPOSED' })
  await assert.rejects(firstSecrets.get('same'), { code: 'SCOPE_DISPOSED' })
})

test('HTTP redirects recheck scoped origins and response limits are bounded', async context => {
  let deniedCalls = 0
  const denied = createServer((_request, response) => { deniedCalls += 1; response.end('must-not-fetch') })
  await new Promise(resolve => denied.listen(0, '127.0.0.1', resolve))
  const deniedOrigin = `http://127.0.0.1:${denied.address().port}`
  const allowed = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: deniedOrigin }); response.end() }
    else if (request.url === '/large') response.end('x'.repeat(1024 * 1024 + 1))
    else response.end('hello')
  })
  await new Promise(resolve => allowed.listen(0, '127.0.0.1', resolve))
  context.after(() => { denied.closeAllConnections(); denied.close(); allowed.closeAllConnections(); allowed.close() })
  const origin = `http://127.0.0.1:${allowed.address().port}`
  const { mount } = await setup(context, [http], [{ id: 'network:http', scope: { origin } }])
  await mount('client', async plugin => {
    const client = plugin.services.require(http)
    assert.equal((await client.request({ url: origin })).text, 'hello')
    await assert.rejects(client.request({ url: `${origin}/redirect` }), { code: 'PERMISSION_DENIED' })
    await assert.rejects(client.request({ url: `${origin}/large` }), /too large/)
  })
  assert.equal(deniedCalls, 0)
})

test('WebSocket text service owns handles, bounds messages and cleans connections', async context => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise(resolve => server.once('listening', resolve))
  server.on('connection', socket => socket.on('message', value => socket.send(value.toString())))
  context.after(() => { for (const socket of server.clients) socket.terminate(); server.close() })
  const address = `ws://127.0.0.1:${server.address().port}`
  const { mount } = await setup(context, [websocket], [{ id: 'network:websocket', scope: { origin: address } }])
  let socketId
  let service
  const handle = await mount('client', async plugin => {
    service = plugin.services.require(websocket)
    socketId = await service.connect(address)
    await service.send(socketId, 'hello')
    assert.equal(await service.receive(socketId), 'hello')
    await assert.rejects(service.send(socketId, 'x'.repeat(65537)), /limit exceeded/)
  })
  await mount('another', async plugin => { await assert.rejects(plugin.services.require(websocket).send(socketId, 'forged'), /foreign/) })
  await handle.dispose()
  await assert.rejects(service.send(socketId, 'stopped'), { code: 'SCOPE_DISPOSED' })
})

test('WebUI contributions and token themes are declarative, namespaced and lifecycle owned', async context => {
  const { mount, ui } = await setup(context, [webui], [{ id: 'webui:contribute' }, { id: 'webui:theme' }])
  const handle = await mount('one', async plugin => {
    const service = plugin.services.require(webui)
    await service.register({ id: 'status', component: 'info-card', title: '<script>not-html</script>' })
    await service.theme({ accent: 'amber', density: 'compact' })
    await assert.rejects(service.register({ id: 'bad', component: 'custom-script' }), /Invalid declarative/)
    await assert.rejects(service.register({ id: 'bad', component: 'info-card', route: '/admin' }), /namespaced/)
  })
  assert.equal(ui.list().length, 1)
  assert.equal(ui.tokens().accent, 'amber')
  await handle.dispose()
  assert.equal(ui.list().length, 0)
  assert.equal(ui.tokens().accent, 'mint')
})

test('logs have bounded retention and redact recognized credential fields', () => {
  const logs = new LogBuffer(2)
  logs.logger.info('one')
  logs.logger.info('two', { token: 'private', nested: { password: 'private' } })
  logs.logger.info('three')
  assert.deepEqual(logs.read().map(record => record.message), ['two', 'three'])
  assert.equal(logs.read()[0].fields.token, '[redacted]')
  assert.equal(logs.read()[0].fields.nested.password, '[redacted]')
})
