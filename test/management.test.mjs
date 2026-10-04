import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createManagementServer, managementRequest } from '../packages/management/dist/index.js'
import { runCli } from '../packages/cli/dist/index.js'

const token = 'a'.repeat(32)
test('management API is authenticated, loopback-bound, bounded and shared with CLI client', async context => {
  const statuses = [{ identity: { instanceId: 'one' }, state: 'running', reasons: [] }]
  const loader = { list: () => statuses }
  const server = await createManagementServer({ token, loader, port: 0 })
  context.after(() => server.close())
  await assert.rejects(fetch(`${server.address}/api/v1/status`), /401|Unauthorized/)
  const response = await managementRequest({ baseUrl: server.address, token }, '/api/v1/status')
  assert.deepEqual(response.plugins, statuses)
  const output = []
  await runCli(['status'], { EASYBOT_MANAGEMENT_URL: server.address, EASYBOT_MANAGEMENT_TOKEN: token }, { write: value => output.push(value) })
  assert.match(output.join(''), /running/)
  const tooLarge = await fetch(`${server.address}/api/v1/status`, { headers: { authorization: `Bearer ${token}`, host: 'evil.test' } })
  assert.equal(tooLarge.status, 400)
  const origin = await fetch(`${server.address}/api/v1/status`, { headers: { authorization: `Bearer ${token}`, origin: 'https://evil.test' } })
  assert.equal(origin.status, 200)
})

test('management actions use same group manager and reject request bodies over limit', async context => {
  const calls = []
  const groupManager = { start: async id => calls.push(['start', id]), stop: async id => calls.push(['stop', id]), rollback: async id => ({ id }), get: id => ({ groupId: id }), list: () => [] }
  const server = await createManagementServer({ token, groupManager, port: 0, maxBodyBytes: 8 })
  context.after(() => server.close())
  const response = await fetch(`${server.address}/api/v1/groups/group%2Fone/start`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [['start', 'group/one']])
  const tooLarge = await fetch(`${server.address}/api/v1/groups/x/start`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-length': '100' }, body: '123456789' })
  assert.equal(tooLarge.status, 413)
})
