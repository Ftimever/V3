import { snapshotJson, type JsonObject, type Logger, type LogFields, type LogLevel } from '@easybot/contracts'

export interface LogRecord { readonly sequence: number; readonly timestamp: string; readonly level: LogLevel; readonly message: string; readonly fields: JsonObject }
const levels: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]'
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (Array.isArray(value)) return value.slice(0, 64).map(item => redact(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [key, /secret|password|token|authorization|cookie/i.test(key) ? '[redacted]' : redact(item, depth + 1)]))
  if (typeof value === 'string') return value.slice(0, 2048)
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return String(value)
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value
}

export class LogBuffer {
  private sequence = 0
  private readonly records: LogRecord[] = []
  readonly logger: Logger
  constructor(private readonly capacity = 500) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new TypeError('Invalid log capacity')
    this.logger = Object.freeze(Object.fromEntries(levels.map(level => [level, (message: string, fields?: LogFields) => this.write(level, message, fields)]))) as unknown as Logger
  }
  write(level: LogLevel, message: string, fields?: LogFields): void {
    if (!levels.includes(level)) throw new TypeError('Invalid log level')
    const sanitized = redact(fields ?? {})
    const encoded = JSON.stringify(sanitized)
    const bounded = Buffer.byteLength(encoded) > 16384 ? { truncated: true } : sanitized
    this.records.push(Object.freeze({ sequence: ++this.sequence, timestamp: new Date().toISOString(), level, message: String(message).slice(0, 2048), fields: snapshotJson(bounded) as JsonObject }))
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity)
  }
  read(after = 0): readonly LogRecord[] { return this.records.filter(record => record.sequence > after) }
}
