import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import Ajv2020 from 'ajv/dist/2020.js'
import { rpcEnvelopeSchema } from '@easybot/contracts/schemas'
import { snapshotJson, type JsonObject, type JsonValue, type RpcCapabilities, type RpcEnvelope, type RpcErrorCode } from '@easybot/contracts'
import { JsonLines, type FramingOptions } from './framing.js'
import { RpcFault } from './errors.js'

const validate = new Ajv2020({ strictRequired: false, allowUnionTypes: true }).compile<RpcEnvelope>(rpcEnvelopeSchema)
const errorCodes = new Set((rpcEnvelopeSchema.$defs as { error: { properties: { code: { enum: string[] } } } }).error.properties.code.enum)

export interface RpcCallContext {
  readonly identity: string
  readonly signal: AbortSignal
  readonly deadline: number
}
export type RpcHandler = (payload: JsonValue | undefined, context: RpcCallContext) => JsonValue | void | Promise<JsonValue | void>
export type RpcStreamHandler = (payload: JsonValue | undefined, context: RpcCallContext) => AsyncIterable<JsonValue>
export interface RpcCallOptions { readonly timeoutMs?: number; readonly signal?: AbortSignal }
export interface RpcPeerOptions extends FramingOptions {
  readonly identity: string
  readonly remoteIdentity: string
  readonly capabilities?: RpcCapabilities
  readonly handshakeTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly maxPending?: number
  readonly streamWindow?: number
  readonly onClose?: (error: Error) => void
}
interface Pending {
  resolve(value: JsonValue | undefined): void
  reject(error: Error): void
  cleanup(): void
}
interface Inbound { readonly controller: AbortController; readonly timer: NodeJS.Timeout }
interface Receiver {
  readonly values: JsonValue[]
  done: boolean
  error?: Error
  wake?: () => void
  cleanup(): void
}
interface Sender { credits: number; readonly limit: number; wake?: () => void }

export class RpcPeer {
  readonly ready: Promise<void>
  private readonly framing: JsonLines
  private readonly handlers = new Map<string, RpcHandler>()
  private readonly streamHandlers = new Map<string, RpcStreamHandler>()
  private readonly pending = new Map<string, Pending>()
  private readonly incoming = new Map<string, Inbound>()
  private readonly receivers = new Map<string, Receiver>()
  private readonly senders = new Map<string, Sender>()
  private readonly maxPending: number
  private readonly window: number
  private readonly requestTimeout: number
  private readonly handshakeTimer: NodeJS.Timeout
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private connected = false
  private closed?: Error

  constructor(input: Readable, output: Writable, private readonly options: RpcPeerOptions) {
    this.options = Object.freeze({ ...options, capabilities: structuredClone(options.capabilities ?? {}) })
    this.maxPending = options.maxPending ?? 128
    this.window = options.streamWindow ?? 16
    this.requestTimeout = options.requestTimeoutMs ?? 30000
    if (!options.identity || !options.remoteIdentity || ![this.maxPending, this.window, this.requestTimeout, options.handshakeTimeoutMs ?? 5000].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Invalid RPC options')
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    void this.ready.catch(() => {})
    this.framing = new JsonLines(input, output, value => this.receive(value), error => this.close(error), options)
    this.handshakeTimer = setTimeout(() => this.close(new RpcFault('REQUEST_TIMEOUT', 'RPC handshake timeout')), options.handshakeTimeoutMs ?? 5000)
    queueMicrotask(() => { void this.send({ type: 'hello', capabilities: this.options.capabilities ?? {} }).catch(error => this.close(error)) })
  }

  private send(message: object): Promise<void> {
    if (this.closed) return Promise.reject(this.closed)
    return this.framing.send({ protocol: 'easybot.rpc', version: 1, pluginInstanceId: this.options.identity, ...message } as JsonObject)
  }

  handle(method: string, handler: RpcHandler): () => void {
    if (this.closed) throw this.closed
    if (!method || method.startsWith('$stream.') || this.handlers.has(method)) throw new RpcFault('INVALID_REQUEST', 'Duplicate or reserved method')
    this.handlers.set(method, handler)
    return () => { if (this.handlers.get(method) === handler) this.handlers.delete(method) }
  }

  handleStream(method: string, handler: RpcStreamHandler): () => void {
    if (!method || this.streamHandlers.has(method)) throw new RpcFault('INVALID_REQUEST', 'Duplicate stream method')
    this.streamHandlers.set(method, handler)
    return () => { this.streamHandlers.delete(method) }
  }

  private timeout(options: RpcCallOptions): number {
    const value = options.timeoutMs ?? this.requestTimeout
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new RpcFault('INVALID_REQUEST', 'Invalid timeout')
    return value
  }

  async request(method: string, payload?: JsonValue, options: RpcCallOptions = {}): Promise<JsonValue | undefined> {
    const snapshot = payload === undefined ? undefined : snapshotJson(payload)
    const timeout = this.timeout(options)
    await this.ready
    if (this.closed) throw this.closed
    if (options.signal?.aborted) throw new RpcFault('REQUEST_CANCELLED', 'Request cancelled')
    if (this.pending.size + this.receivers.size >= this.maxPending) throw new RpcFault('PLUGIN_UNAVAILABLE', 'RPC pending limit exceeded')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const cancel = (error: Error): void => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.cleanup()
        reject(error)
        void this.send({ type: 'cancel', id, reason: error.message }).catch(() => {})
      }
      const abort = (): void => cancel(new RpcFault('REQUEST_CANCELLED', 'Request cancelled'))
      const timer = setTimeout(() => cancel(new RpcFault('REQUEST_TIMEOUT', method)), timeout)
      options.signal?.addEventListener('abort', abort, { once: true })
      const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
      this.pending.set(id, { resolve, reject, cleanup })
      void this.send({ type: 'request', id, method, deadline: Date.now() + timeout, ...(snapshot === undefined ? {} : { payload: snapshot }) }).catch(error => cancel(error))
    })
  }

  async notify(method: string, payload?: JsonValue): Promise<void> {
    await this.ready
    await this.send({ type: 'notification', method, ...(payload === undefined ? {} : { payload: snapshotJson(payload) }) })
  }

  private begin(id: string, deadline = Date.now() + this.requestTimeout): RpcCallContext {
    if (this.incoming.has(id) || this.incoming.size >= this.maxPending) throw new RpcFault('INVALID_REQUEST', 'Duplicate request or inbound limit exceeded')
    const controller = new AbortController()
    const timeout = Math.min(Math.max(0, deadline - Date.now()), this.requestTimeout)
    const timer = setTimeout(() => { controller.abort(); this.senders.get(id)?.wake?.() }, timeout)
    this.incoming.set(id, { controller, timer })
    if (deadline <= Date.now()) controller.abort()
    return Object.freeze({ identity: this.options.remoteIdentity, signal: controller.signal, deadline })
  }

  private finish(id: string): void {
    const entry = this.incoming.get(id)
    if (entry) clearTimeout(entry.timer)
    this.incoming.delete(id)
    this.senders.delete(id)
  }

  private fault(error: unknown): { code: RpcErrorCode; message: string } {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && errorCodes.has(error.code) ? error.code as RpcErrorCode : 'INTERNAL_ERROR'
    return { code, message: error instanceof Error ? error.message : String(error) }
  }

  private receive(value: unknown): void {
    if (this.closed) return
    if (!validate(value)) throw new RpcFault('INVALID_REQUEST', 'Invalid RPC envelope')
    const message = value
    if (message.pluginInstanceId !== this.options.remoteIdentity) throw new RpcFault('PERMISSION_DENIED', 'RPC connection identity mismatch')
    if (message.type === 'hello' || message.type === 'hello-ack') {
      if (message.type === 'hello') void this.send({ type: 'hello-ack', capabilities: this.options.capabilities ?? {} }).catch(error => this.close(error))
      else if (!this.connected) { this.connected = true; clearTimeout(this.handshakeTimer); this.resolveReady() }
      return
    }
    if (!this.connected) throw new RpcFault('PROTOCOL_MISMATCH', 'RPC handshake required')
    if (message.type === 'response') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      pending.cleanup()
      if (message.ok) pending.resolve(message.payload)
      else pending.reject(new RpcFault(message.error.code, message.error.message))
    } else if (message.type === 'request') {
      const context = this.begin(message.id, message.deadline)
      void (async () => {
        try {
          const handler = this.handlers.get(message.method)
          if (!handler) throw new RpcFault('METHOD_NOT_FOUND', message.method)
          if (context.signal.aborted) throw new RpcFault('REQUEST_TIMEOUT', message.method)
          const result = await handler(message.payload, context)
          if (!context.signal.aborted) await this.send({ type: 'response', id: message.id, ok: true, ...(result === undefined ? {} : { payload: snapshotJson(result) }) })
        } catch (error) {
          await this.send({ type: 'response', id: message.id, ok: false, error: this.fault(error) }).catch(() => {})
        } finally { this.finish(message.id) }
      })()
    } else if (message.type === 'cancel') {
      this.incoming.get(message.id)?.controller.abort()
      this.senders.get(message.id)?.wake?.()
    } else if (message.type === 'notification') {
      if (message.method === '$stream.credit') {
        const payload = message.payload as JsonObject | undefined
        const sender = typeof payload?.id === 'string' ? this.senders.get(payload.id) : undefined
        if (!sender) return
        if (!Number.isSafeInteger(payload?.count) || Number(payload?.count) <= 0 || sender.credits + Number(payload?.count) > sender.limit) throw new RpcFault('INVALID_REQUEST', 'Invalid stream credits')
        sender.credits += Number(payload?.count)
        sender.wake?.()
      } else {
        const id = randomUUID()
        const context = this.begin(id, message.deadline)
        void Promise.resolve().then(() => this.handlers.get(message.method)?.(message.payload, context)).catch(() => {}).finally(() => this.finish(id))
      }
    } else if (message.type === 'stream') this.receiveStream(message)
  }

  async stream(method: string, payload?: JsonValue, options: RpcCallOptions = {}): Promise<AsyncIterableIterator<JsonValue>> {
    const timeout = this.timeout(options)
    const snapshot = payload === undefined ? null : snapshotJson(payload)
    await this.ready
    if (this.closed) throw this.closed
    if (options.signal?.aborted) throw new RpcFault('REQUEST_CANCELLED', method)
    if (this.pending.size + this.receivers.size >= this.maxPending) throw new RpcFault('PLUGIN_UNAVAILABLE', 'RPC pending limit exceeded')
    const id = randomUUID()
    const cancel = (error?: Error): void => {
      if (receiver.done) return
      receiver.done = true
      receiver.error = error
      receiver.cleanup()
      this.receivers.delete(id)
      receiver.wake?.()
      void this.send({ type: 'cancel', id, reason: error?.message ?? 'Iterator closed' }).catch(() => {})
    }
    const abort = (): void => cancel(new RpcFault('REQUEST_CANCELLED', method))
    const timer = setTimeout(() => cancel(new RpcFault('REQUEST_TIMEOUT', method)), timeout)
    options.signal?.addEventListener('abort', abort, { once: true })
    const receiver: Receiver = { values: [], done: false, cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) } }
    this.receivers.set(id, receiver)
    try {
      await this.send({ type: 'stream', id, stream: 'open', deadline: Date.now() + timeout, payload: { method, payload: snapshot, window: this.window } })
      await this.send({ type: 'notification', method: '$stream.credit', payload: { id, count: this.window } })
    } catch (error) { cancel(error as Error); throw error }
    const peer = this
    const iterator: AsyncIterableIterator<JsonValue> = {
      [Symbol.asyncIterator]() { return this },
      async next() {
        while (!receiver.values.length && !receiver.done) await new Promise<void>(resolve => { receiver.wake = resolve })
        receiver.wake = undefined
        if (receiver.error) throw receiver.error
        if (receiver.values.length) {
          const value = receiver.values.shift()!
          if (!receiver.done) await peer.send({ type: 'notification', method: '$stream.credit', payload: { id, count: 1 } })
          return { done: false, value }
        }
        return { done: true, value: undefined }
      },
      async return() { cancel(); receiver.values.length = 0; return { done: true, value: undefined } },
    }
    return iterator
  }

  private receiveStream(message: Extract<RpcEnvelope, { type: 'stream' }>): void {
    if (message.stream !== 'open') {
      const receiver = this.receivers.get(message.id)
      if (!receiver) return
      if (message.stream === 'close') {
        receiver.done = true
        receiver.error = message.error ? new RpcFault(message.error.code, message.error.message) : undefined
        receiver.cleanup()
        this.receivers.delete(message.id)
      } else {
        if (receiver.values.length >= this.window || message.payload === undefined) throw new RpcFault('INVALID_PAYLOAD', 'Stream overflow or empty chunk')
        receiver.values.push(snapshotJson(message.payload))
      }
      receiver.wake?.()
      return
    }
    const context = this.begin(message.id, message.deadline)
    const request = message.payload as JsonObject | undefined
    const limit = Number(request?.window)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new RpcFault('INVALID_REQUEST', 'Invalid stream window')
    const sender: Sender = { credits: 0, limit }
    this.senders.set(message.id, sender)
    void (async () => {
      try {
        const handler = typeof request?.method === 'string' ? this.streamHandlers.get(request.method) : undefined
        if (!handler) throw new RpcFault('METHOD_NOT_FOUND', String(request?.method))
        const iterator = handler(request?.payload, context)[Symbol.asyncIterator]()
        try {
          while (!context.signal.aborted) {
            while (!sender.credits && !context.signal.aborted) await new Promise<void>(resolve => { sender.wake = resolve })
            sender.wake = undefined
            if (context.signal.aborted) break
            const item = await iterator.next()
            if (item.done) break
            sender.credits -= 1
            await this.send({ type: 'stream', id: message.id, stream: 'chunk', payload: snapshotJson(item.value) })
          }
        } finally { await iterator.return?.() }
        await this.send({ type: 'stream', id: message.id, stream: 'close' })
      } catch (error) {
        await this.send({ type: 'stream', id: message.id, stream: 'close', error: this.fault(error) }).catch(() => {})
      } finally { this.finish(message.id) }
    })()
  }

  close(error: Error = new RpcFault('PLUGIN_UNAVAILABLE', 'RPC peer closed')): void {
    if (this.closed) return
    this.closed = error
    clearTimeout(this.handshakeTimer)
    this.framing.close()
    this.rejectReady(error)
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error) }
    this.pending.clear()
    for (const receiver of this.receivers.values()) { receiver.cleanup(); receiver.error = error; receiver.done = true; receiver.wake?.() }
    this.receivers.clear()
    for (const [id, entry] of this.incoming) { entry.controller.abort(); clearTimeout(entry.timer); this.senders.get(id)?.wake?.() }
    this.options.onClose?.(error)
  }
}
