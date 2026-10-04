import type { JsonValue } from './index.js'

export function snapshotJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || value === null || ancestors.has(value)) throw new TypeError('Expected finite, acyclic JSON')
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Expected a plain JSON object')
  ancestors.add(value)
  const result = Array.isArray(value)
    ? Array.from(value, item => snapshotJson(item, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotJson(item, ancestors)]))
  ancestors.delete(value)
  return Object.freeze(result)
}
