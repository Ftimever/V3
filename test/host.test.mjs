import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHost } from '../packages/host/dist/index.js'

test('self-host creates persistent state, serves authenticated management API, and reuses token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easybot-host-'))
  const options = { cwd: directory, config: { dataDirectory: 'data', management: { port: 0 } } }
  let host = await createHost(options)
  try {
    assert.equal(host.tokenSource, 'generated')
    assert.equal((await fetch(`${host.management.address}/api/v1/status`)).status, 401)
    const response = await fetch(`${host.management.address}/api/v1/status`, { headers: { authorization: `Bearer ${host.token}` } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { plugins: [], groups: [] })
    await stat(join(directory, 'data', 'easybot.sqlite'))
    await stat(join(directory, 'data', 'master.key'))
    assert.equal((await readFile(join(directory, 'data', 'management.token'), 'utf8')).trim(), host.token)
    await host.close()
    await host.close()
    host = await createHost(options)
    assert.equal(host.tokenSource, 'file')
    assert.equal(host.token, (await readFile(join(directory, 'data', 'management.token'), 'utf8')).trim())
  } finally {
    await host.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})
