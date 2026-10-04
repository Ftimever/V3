import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { URL } from 'node:url'
import type { JsonObject, JsonValue } from '@easybot/contracts'
import type { PluginLoader } from '@easybot/loader'
import type { PluginGroupManager } from '@easybot/plugin-group'

export interface ManagementServerOptions {
  readonly groupManager?: PluginGroupManager
  readonly loader?: PluginLoader
  readonly token: string
  readonly host?: string
  readonly port?: number
  readonly allowedOrigin?: string
  readonly maxBodyBytes?: number
}
export interface ManagementServer { readonly address: string; close(): Promise<void> }
export interface ManagementClientOptions { readonly baseUrl: string; readonly token: string; readonly fetch?: typeof globalThis.fetch }

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
function reject(response: ServerResponse, status: number, code: string, message: string): void { response.writeHead(status, jsonHeaders); response.end(JSON.stringify({ error: { code, message } })) }
function tokenEqual(actual: string, expected: string): boolean {
  const left = createHash('sha256').update(actual).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}
async function body(request: IncomingMessage, max: number): Promise<JsonObject> {
  const length = Number(request.headers['content-length'] ?? 0)
  if (length > max) throw Object.assign(new Error('Request body too large'), { status: 413, code: 'INVALID_REQUEST' })
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > max) throw Object.assign(new Error('Request body too large'), { status: 413, code: 'INVALID_REQUEST' }); chunks.push(Buffer.from(chunk)) }
  if (!chunks.length) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(new Error('JSON object required'), { status: 400, code: 'INVALID_REQUEST' })
  return parsed as JsonObject
}
function send(response: ServerResponse, value: JsonValue, status = 200): void { response.writeHead(status, jsonHeaders); response.end(JSON.stringify(value)) }
function snapshot(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value ?? null)) as JsonValue }

export function createManagementServer(options: ManagementServerOptions): Promise<ManagementServer> {
  if (!options.token || options.token.length < 24) return Promise.reject(new TypeError('Management token must contain at least 24 characters'))
  const host = options.host ?? '127.0.0.1'
  const maxBody = options.maxBodyBytes ?? 1024 * 1024
  if (!Number.isSafeInteger(maxBody) || maxBody <= 0 || !['127.0.0.1', '::1', 'localhost'].includes(host)) return Promise.reject(new TypeError('Management server only binds approved loopback hosts'))
  let boundPort = options.port ?? 0
  const server: Server = createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') { response.writeHead(204, { ...(options.allowedOrigin ? { 'access-control-allow-origin': options.allowedOrigin, vary: 'Origin' } : {}), 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'authorization,content-type' }); response.end(); return }
      const expectedHost = host === '::1' ? `[${host}]:${boundPort}` : `${host}:${boundPort}`
      if (request.headers.host !== expectedHost) { reject(response, 400, 'INVALID_REQUEST', 'Unexpected Host header'); return }
      if (options.allowedOrigin && request.headers.origin && request.headers.origin !== options.allowedOrigin) { reject(response, 403, 'PERMISSION_DENIED', 'Origin not allowed'); return }
      const authorization = request.headers.authorization
      if (!authorization || !authorization.startsWith('Bearer ') || !tokenEqual(authorization.slice(7), options.token)) { reject(response, 401, 'PERMISSION_DENIED', 'Authentication required'); return }
      const url = new URL(request.url ?? '/', `http://${host}`)
      const segments = url.pathname.split('/').filter(Boolean)
      if (request.method === 'GET' && url.pathname === '/api/v1/status') send(response, snapshot({ plugins: options.loader?.list() ?? [], groups: options.groupManager?.list() ?? [] }))
      else if (request.method === 'GET' && url.pathname === '/api/v1/plugins') send(response, snapshot(options.loader?.list() ?? []))
      else if (request.method === 'GET' && url.pathname === '/api/v1/groups') send(response, snapshot(options.groupManager?.list() ?? []))
      else if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'groups' && segments.length === 5 && options.groupManager) {
        const groupId = decodeURIComponent(segments[3] ?? ''); const action = segments[4] ?? ''
        await body(request, maxBody)
        if (action === 'start') { await options.groupManager.start(groupId); send(response, snapshot(options.groupManager.get(groupId))) }
        else if (action === 'stop') { await options.groupManager.stop(groupId); send(response, snapshot(options.groupManager.get(groupId))) }
        else if (action === 'rollback') send(response, snapshot(await options.groupManager.rollback(groupId)))
        else reject(response, 404, 'DEPENDENCY_NOT_FOUND', 'Unknown group action')
      } else reject(response, 404, 'DEPENDENCY_NOT_FOUND', 'Unknown management route')
    } catch (error) {
      const value = error as { status?: number; code?: string; message?: string }
      if (!response.headersSent) {
        reject(response, value.status ?? 500, value.code ?? 'INTERNAL_ERROR', value.message ?? String(error))
      } else {
        response.destroy()
      }
    }
  })
  return new Promise((resolve, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(options.port ?? 0, host, () => { server.removeListener('error', rejectPromise); const address = server.address(); const port = typeof address === 'object' && address ? address.port : options.port ?? 0; boundPort = port; resolve({ address: `http://${host === '::1' ? `[${host}]` : host}:${port}`, close: () => new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose())) }) })
  })
}

export async function managementRequest<T = unknown>(options: ManagementClientOptions, path: string, init: RequestInit = {}): Promise<T> {
  const fetcher = options.fetch ?? globalThis.fetch
  const url = new URL(path, options.baseUrl)
  const response = await fetcher(url, { ...init, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}), authorization: `Bearer ${options.token}` } })
  const value: unknown = await response.json()
  if (!response.ok) throw Object.assign(new Error((value as { error?: { message?: string } }).error?.message ?? response.statusText), { status: response.status, ...(value as object) })
  return value as T
}
