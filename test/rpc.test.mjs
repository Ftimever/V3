import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { RpcPeer, JsonLines } from '../packages/rpc/dist/index.js'

function pair(options = {}) {
  const forward = new PassThrough()
  const reverse = new PassThrough()
  const host = new RpcPeer(reverse, forward, { identity: 'host', remoteIdentity: 'child', ...options })
  const child = new RpcPeer(forward, reverse, { identity: 'child', remoteIdentity: 'host', ...options })
  return { host, child, forward, reverse, close() { host.close(); child.close(); forward.destroy(); reverse.destroy() } }
}

test('RPC handshake authenticates fixed connection identity and calls return structured errors', async () => {
  const peers = pair()
  try {
    peers.child.handle('echo', (value, context) => ({ value, caller: context.identity }))
    assert.deepEqual(await peers.host.request('echo', { unicode: '你好' }), { value: { unicode: '你好' }, caller: 'host' })
    await assert.rejects(peers.host.request('private'), { code: 'METHOD_NOT_FOUND' })
    await assert.rejects(peers.host.request('echo', { invalid: undefined }))
  } finally { peers.close() }
})

test('RPC deadlines, cancellation and pending limits are bounded', async () => {
  const peers = pair({ maxPending: 1 })
  let cancelled = false
  peers.child.handle('wait', async (_value, context) => {
    await new Promise(resolve => context.signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }))
  })
  try {
    await Promise.all([peers.host.ready, peers.child.ready])
    const controller = new AbortController()
    const pending = peers.host.request('wait', null, { signal: controller.signal, timeoutMs: 1000 })
    await delay(10)
    await assert.rejects(peers.host.request('wait'), { code: 'PLUGIN_UNAVAILABLE' })
    controller.abort()
    await assert.rejects(pending, { code: 'REQUEST_CANCELLED' })
    await delay(10)
    assert.equal(cancelled, true)
    await assert.rejects(peers.host.request('wait', null, { timeoutMs: 10 }), { code: 'REQUEST_TIMEOUT' })
    await assert.rejects(peers.host.request('wait', null, { timeoutMs: Infinity }), { code: 'INVALID_REQUEST' })
  } finally { peers.close() }
})

test('RPC stream credit window provides producer backpressure and iterator cancellation', async () => {
  const peers = pair({ streamWindow: 2 })
  let produced = 0
  let disposed = false
  peers.child.handleStream('numbers', async function* () {
    try { for (let value = 0; value < 100; value += 1) { produced += 1; yield value } }
    finally { disposed = true }
  })
  try {
    const stream = await peers.host.stream('numbers')
    await delay(20)
    assert.equal(produced, 2)
    assert.deepEqual(await stream.next(), { done: false, value: 0 })
    await delay(20)
    assert.equal(produced, 3)
    await stream.return()
    await delay(20)
    assert.equal(disposed, true)
  } finally { peers.close() }
})

test('RPC stream completes and propagates producer errors', async () => {
  const peers = pair()
  peers.child.handleStream('values', async function* () { yield 1; yield { value: 2 } })
  peers.child.handleStream('failure', async function* () { throw new Error('stream-failure') })
  try {
    const values = []
    for await (const value of await peers.host.stream('values')) values.push(value)
    assert.deepEqual(values, [1, { value: 2 }])
    const stream = await peers.host.stream('failure')
    await assert.rejects(stream.next(), /stream-failure/)
  } finally { peers.close() }
})

test('RPC rejects identity forgery and rejects pending work on close', async () => {
  const peers = pair()
  peers.child.handle('wait', async () => delay(30))
  try {
    await Promise.all([peers.host.ready, peers.child.ready])
    const pending = peers.host.request('wait')
    peers.reverse.write(`${JSON.stringify({ protocol: 'easybot.rpc', version: 1, type: 'notification', method: 'bad', pluginInstanceId: 'another-plugin' })}\n`)
    await assert.rejects(pending, { code: 'PERMISSION_DENIED' })
  } finally { peers.close() }
})

test('framing accepts fragmented UTF-8 and fails oversized, invalid UTF-8 and malformed JSON', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const received = []
  const errors = []
  const framing = new JsonLines(input, output, value => received.push(value), error => errors.push(error), { maxFrameBytes: 32, maxQueuedBytes: 40 })
  try {
    const bytes = Buffer.from('"你好"\n')
    for (const byte of bytes) input.write(Buffer.from([byte]))
    assert.deepEqual(received, ['你好'])
    input.write('x'.repeat(33))
    assert.equal(errors[0].code, 'INVALID_PAYLOAD')
    await assert.rejects(framing.send('x'.repeat(33)), { code: 'INVALID_PAYLOAD' })
  } finally { framing.close(); input.destroy(); output.destroy() }
  for (const bytes of [Buffer.from('{invalid}\n'), Buffer.from([0xff, 10])]) {
    const incoming = new PassThrough()
    const outgoing = new PassThrough()
    const failures = []
    const transport = new JsonLines(incoming, outgoing, () => assert.fail(), error => failures.push(error))
    incoming.write(bytes)
    assert.equal(failures.length, 1)
    transport.close(); incoming.destroy(); outgoing.destroy()
  }
})
