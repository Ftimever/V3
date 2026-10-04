import type { Readable, Writable } from 'node:stream'
import { snapshotJson, type JsonValue } from '@easybot/contracts'
import { RpcFault } from './errors.js'

export interface FramingOptions {
  readonly maxFrameBytes?: number
  readonly maxQueuedBytes?: number
}

export class JsonLines {
  private buffer = Buffer.alloc(0)
  private queuedBytes = 0
  private tail = Promise.resolve()
  private closed = false
  readonly maxFrameBytes: number
  readonly maxQueuedBytes: number

  constructor(private readonly input: Readable, private readonly output: Writable, private readonly receive: (value: unknown) => void, private readonly fail: (error: Error) => void, options: FramingOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024
    this.maxQueuedBytes = options.maxQueuedBytes ?? 4 * 1024 * 1024
    if (![this.maxFrameBytes, this.maxQueuedBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Invalid framing limits')
    input.on('data', this.data)
    input.on('end', this.end)
    input.on('error', this.error)
    input.on('close', this.end)
    output.on('error', this.error)
    output.on('close', this.end)
  }

  private readonly error = (error: Error): void => { if (!this.closed) this.fail(error) }
  private readonly end = (): void => { if (!this.closed) this.fail(new RpcFault('PLUGIN_UNAVAILABLE', 'RPC transport closed')) }
  private readonly data = (chunk: Buffer | string): void => {
    if (this.closed) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let offset = 0
    try {
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset)
        const end = newline === -1 ? bytes.length : newline
        const part = bytes.subarray(offset, end)
        if (this.buffer.length + part.length > this.maxFrameBytes) throw new RpcFault('INVALID_PAYLOAD', 'RPC frame too large')
        this.buffer = Buffer.concat([this.buffer, part])
        if (newline === -1) break
        const frame = this.buffer
        this.buffer = Buffer.alloc(0)
        if (!frame.length) throw new RpcFault('INVALID_REQUEST', 'Empty RPC frame')
        const text = new TextDecoder('utf-8', { fatal: true }).decode(frame)
        this.receive(JSON.parse(text))
        if (this.closed) return
        offset = end + 1
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
  }

  send(value: JsonValue): Promise<void> {
    if (this.closed) return Promise.reject(new RpcFault('PLUGIN_UNAVAILABLE', 'RPC transport closed'))
    let bytes: Buffer
    try { bytes = Buffer.from(`${JSON.stringify(snapshotJson(value))}\n`) } catch (error) { return Promise.reject(error) }
    if (bytes.length - 1 > this.maxFrameBytes || this.queuedBytes + bytes.length > this.maxQueuedBytes) return Promise.reject(new RpcFault('INVALID_PAYLOAD', 'RPC outbound limit exceeded'))
    this.queuedBytes += bytes.length
    const result = this.tail.then(() => new Promise<void>((resolve, reject) => {
      if (this.closed) { reject(new RpcFault('PLUGIN_UNAVAILABLE', 'RPC transport closed')); return }
      this.output.write(bytes, error => error ? reject(error) : resolve())
    })).finally(() => { this.queuedBytes -= bytes.length })
    this.tail = result.catch(() => {})
    return result
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.buffer = Buffer.alloc(0)
    this.input.off('data', this.data)
    this.input.off('end', this.end)
    this.input.off('close', this.end)
    this.input.off('error', this.error)
    this.output.off('error', this.error)
    this.output.off('close', this.end)
  }
}
