import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { snapshotJson, type JsonValue } from '@easybot/contracts'

export interface StateRecord<Value extends JsonValue = JsonValue> {
  readonly revision: number
  readonly value: Value
}

export class StateConflictError extends Error {
  readonly code = 'VERSION_MISMATCH'
}

export class StateStore {
  private readonly database: DatabaseSync
  private closed = false

  constructor(path: string) {
    this.database = new DatabaseSync(path)
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (namespace TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key));')
  }

  private active(): void {
    if (this.closed) throw new Error('State store is closed')
  }

  get<Value extends JsonValue = JsonValue>(namespace: string, key: string): StateRecord<Value> | undefined {
    this.active()
    const row = this.database.prepare('SELECT revision,value FROM records WHERE namespace=? AND key=?').get(namespace, key)
    return row ? { revision: Number(row.revision), value: JSON.parse(String(row.value)) as Value } : undefined
  }

  put(namespace: string, key: string, value: JsonValue, expectedRevision: number): StateRecord {
    this.active()
    if (!namespace || !key || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('Invalid state key or revision')
    const encoded = JSON.stringify(snapshotJson(value))
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.get(namespace, key)
      if ((previous?.revision ?? 0) !== expectedRevision) throw new StateConflictError(`Stale revision: ${namespace}/${key}`)
      const revision = expectedRevision + 1
      this.database.prepare('INSERT INTO records(namespace,key,revision,value) VALUES(?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET revision=excluded.revision,value=excluded.value').run(namespace, key, revision, encoded)
      this.database.exec('COMMIT')
      return { revision, value: JSON.parse(encoded) as JsonValue }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  keys(namespace: string): readonly string[] {
    this.active()
    return this.database.prepare('SELECT key FROM records WHERE namespace=? ORDER BY key').all(namespace).map(row => String(row.key))
  }

  delete(namespace: string, key: string, expectedRevision: number): void {
    this.active()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if ((this.get(namespace, key)?.revision ?? 0) !== expectedRevision) throw new StateConflictError(`Stale revision: ${namespace}/${key}`)
      this.database.prepare('DELETE FROM records WHERE namespace=? AND key=?').run(namespace, key)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }
}

export class SecretVault {
  private readonly key: Buffer

  constructor(private readonly store: StateStore, key: Uint8Array) {
    if (key.byteLength !== 32) throw new TypeError('Secret master key must contain 32 bytes')
    this.key = Buffer.from(key)
  }

  set(id: string, value: string): void {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(id))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const previous = this.store.get('secrets', id)
    this.store.put('secrets', id, { nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }, previous?.revision ?? 0)
  }

  get(id: string): string | undefined {
    const record = this.store.get('secrets', id)
    if (!record) return undefined
    const encrypted = record.value as { nonce: string; ciphertext: string; tag: string }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encrypted.nonce, 'base64'))
    decipher.setAAD(Buffer.from(id))
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString('utf8')
  }

  delete(id: string): void {
    const record = this.store.get('secrets', id)
    if (record) this.store.delete('secrets', id, record.revision)
  }
}
