import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import type { PluginContext, Dispose } from '@easybot/contracts'
import type { HttpRequest, HttpService, WebSocketService } from './tokens.js'

export function httpFor(context: PluginContext): HttpService {
  return Object.freeze({ request: async (input: HttpRequest) => {
    context.lifecycle.assertActive()
    const timeout = input.timeoutMs ?? 30000
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120000) throw new TypeError('Invalid HTTP timeout')
    if (input.body !== undefined && Buffer.byteLength(input.body) > 1024 * 1024) throw new TypeError('HTTP request body too large')
    let url = new URL(input.url)
    let method = (input.method ?? 'GET').toUpperCase()
    let body = input.body
    const headers = new Headers(input.headers)
    for (const name of ['host', 'connection', 'content-length', 'transfer-encoding']) if (headers.has(name)) throw new TypeError('Transport headers cannot be overridden')
    const controller = new AbortController()
    const dispose = context.lifecycle.add(() => controller.abort())
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      for (let redirect = 0; redirect <= 5; redirect += 1) {
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('HTTP URLs require http(s) without embedded credentials')
        context.capabilities.require('network:http', { origin: url.origin, hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? '443' : '80') })
        const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: controller.signal })
        const location = response.headers.get('location')
        if ([301, 302, 303, 307, 308].includes(response.status) && location) {
          await response.body?.cancel()
          if (redirect === 5) throw new TypeError('HTTP redirect limit exceeded')
          const next = new URL(location, url)
          if (next.origin !== url.origin) { headers.delete('authorization'); headers.delete('cookie') }
          if (response.status === 303 || [301, 302].includes(response.status) && method === 'POST') { method = 'GET'; body = undefined; headers.delete('content-type') }
          url = next
          continue
        }
        const chunks: Uint8Array[] = []
        let size = 0
        const reader = response.body?.getReader()
        if (reader) {
          try {
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) break
              size += chunk.value.byteLength
              if (size > 1024 * 1024) { await reader.cancel(); throw new TypeError('HTTP response too large') }
              chunks.push(chunk.value)
            }
          } finally { reader.releaseLock() }
        }
        return { status: response.status, headers: Object.fromEntries(response.headers), text: Buffer.concat(chunks).toString('utf8') }
      }
      throw new TypeError('HTTP redirect limit exceeded')
    } finally { clearTimeout(timer); await dispose() }
  } })
}

interface SocketRecord {
  readonly socket: WebSocket
  readonly url: URL
  readonly queue: string[]
  bytes: number
  error?: Error
  waiting?: { resolve(value: string): void; reject(error: Error): void }
  dispose: Dispose
}

export function websocketFor(context: PluginContext): WebSocketService {
  const sockets = new Map<string, SocketRecord>()
  const permission = (url: URL): void => context.capabilities.require('network:websocket', { origin: url.origin, hostname: url.hostname, port: url.port || (url.protocol === 'wss:' ? '443' : '80') })
  const get = (id: string): SocketRecord => {
    context.lifecycle.assertActive()
    const record = sockets.get(id)
    if (!record) throw new TypeError('Unknown or foreign WebSocket handle')
    permission(record.url)
    return record
  }
  return Object.freeze({
    connect: async (address: string) => {
      context.lifecycle.assertActive()
      if (sockets.size >= 8) throw new TypeError('WebSocket connection limit exceeded')
      const url = new URL(address)
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Invalid WebSocket URL')
      permission(url)
      const socket = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 65536, followRedirects: false, perMessageDeflate: false })
      const id = randomUUID()
      const record: SocketRecord = { socket, url, queue: [], bytes: 0, dispose: () => {} }
      const fail = (error: Error): void => { record.error = error; record.waiting?.reject(error); record.waiting = undefined }
      socket.on('error', fail)
      socket.on('close', () => fail(new Error('WebSocket closed')))
      record.dispose = context.lifecycle.add(() => { sockets.delete(id); fail(new Error('WebSocket disposed')); socket.terminate() })
      sockets.set(id, record)
      socket.on('message', (data, binary) => {
        if (binary) { fail(new TypeError('Only text WebSocket messages are supported')); socket.terminate(); return }
        const text = data.toString()
        const bytes = Buffer.byteLength(text)
        if (record.waiting) { const waiting = record.waiting; record.waiting = undefined; waiting.resolve(text) }
        else if (record.queue.length >= 64 || record.bytes + bytes > 1024 * 1024) { fail(new Error('WebSocket inbound queue exceeded')); socket.terminate() }
        else { record.queue.push(text); record.bytes += bytes }
      })
      try { await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('WebSocket closed before open'))) }) }
      catch (error) { await record.dispose(); throw error }
      return id
    },
    send: async (id: string, text: string) => {
      const record = get(id)
      if (typeof text !== 'string' || Buffer.byteLength(text) > 65536 || record.socket.bufferedAmount + Buffer.byteLength(text) > 1024 * 1024) throw new TypeError('WebSocket outbound limit exceeded')
      await new Promise<void>((resolve, reject) => record.socket.send(text, error => error ? reject(error) : resolve()))
    },
    receive: async (id: string, timeoutMs = 30000) => {
      const record = get(id)
      if (record.error) throw record.error
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000 || record.waiting) throw new TypeError('Invalid timeout or concurrent WebSocket receiver')
      if (record.queue.length) { const text = record.queue.shift()!; record.bytes -= Buffer.byteLength(text); return text }
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { record.waiting = undefined; reject(new Error('WebSocket receive timeout')) }, timeoutMs)
        record.waiting = { resolve: text => { clearTimeout(timer); resolve(text) }, reject: error => { clearTimeout(timer); reject(error) } }
      })
    },
    close: async (id: string) => { await get(id).dispose() },
  })
}
