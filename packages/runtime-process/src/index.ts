import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { snapshotJson, type Dispose, type EventDefinition, type EventMiddlewareOrdering, type JsonObject, type JsonValue, type PermissionGrant, type PermissionRequest, type PipelineResult, type PluginContext, type PluginManifest, type ServiceReference, type ServiceRegistration, type ServiceToken } from '@easybot/contracts'
import { RpcPeer, RpcFault } from '@easybot/rpc'

export interface ProcessOptions {
  readonly entry: string
  readonly directory: string
  readonly manifest: PluginManifest
  readonly config: JsonObject
  readonly policy?: readonly PermissionRequest[]
  readonly grants?: readonly PermissionGrant[]
  readonly services?: readonly ServiceReference[]
  readonly startupTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly onFailure?: (error: Error) => void
}
export interface ProcessHandle { readonly pid: number; dispose: Dispose; reconfigure(next: JsonObject, previous: JsonObject): Promise<void> }

async function killTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => { child.kill(); resolve() })
      killer.once('exit', () => resolve())
    })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error }
  }
}

export async function startProcessPlugin(context: PluginContext, options: ProcessOptions): Promise<ProcessHandle> {
  if (options.manifest.runtime.kind !== 'child-process' || (options.manifest.runtime.protocolVersion ?? 1) !== 1) throw new RpcFault('PROTOCOL_MISMATCH', 'Unsupported child-process protocol')
  const timeout = options.startupTimeoutMs ?? 10000
  const shutdownTimeout = options.shutdownTimeoutMs ?? 2000
  const environment = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'LANG'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), context.plugin.instanceId], { cwd: options.directory, env: environment, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' })
  let stopping = false
  let failureReported = false
  let disposal: Promise<void> | undefined
  const report = (error: Error): void => {
    if (!stopping && !failureReported) { failureReported = true; options.onFailure?.(error) }
  }
  const peer = new RpcPeer(child.stdout, child.stdin, { identity: 'easybot.host', remoteIdentity: context.plugin.instanceId, handshakeTimeoutMs: timeout, onClose: report })
  const exited = new Promise<void>(resolve => {
    child.once('exit', (code, signal) => { const error = new RpcFault('PLUGIN_UNAVAILABLE', `Plugin process exited (${code ?? signal})`); peer.close(error); report(error); resolve() })
    child.once('error', error => { peer.close(error); report(error); resolve() })
  })
  child.stderr.on('data', (bytes: Buffer) => context.logger.info('child.stderr', { text: bytes.subarray(0, 8192).toString('utf8'), pid: child.pid }))
  const dispose = (): Promise<void> => {
    if (!disposal) {
      stopping = true
      disposal = (async () => {
        await peer.request('runtime.stop', undefined, { timeoutMs: shutdownTimeout }).catch(() => {})
        peer.close()
        if (child.exitCode === null && child.signalCode === null) await killTree(child)
        await exited
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
      })()
    }
    return disposal
  }
  context.lifecycle.add(dispose)
  const registrations = new Map<string, ServiceRegistration>()
  const listeners = new Map<string, Dispose>()
  const fields = (payload: JsonValue | undefined): JsonObject => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new RpcFault('INVALID_PAYLOAD', 'Expected RPC object')
    return payload as JsonObject
  }
  peer.handle('services.call', async payload => {
    const request = fields(payload)
    const token = request.token as unknown as ServiceToken<Record<string, (...args: JsonValue[]) => unknown>>
    const declaration = options.services?.find(service => service.id === token?.id)
    if (!declaration?.methods?.includes(String(request.method))) throw new RpcFault('METHOD_NOT_FOUND', String(request.method))
    const service = context.services.require(token)
    const method = service[String(request.method)]
    if (typeof method !== 'function' || !Array.isArray(request.args)) throw new RpcFault('METHOD_NOT_FOUND', String(request.method))
    const result = await method.apply(service, request.args)
    return result === undefined ? undefined : snapshotJson(result)
  })
  peer.handle('services.provide', payload => {
    const request = fields(payload)
    const token = request.token as unknown as ServiceToken<Record<string, unknown>>
    const declaration = options.manifest.provides?.services?.find(service => service.id === token?.id && service.version === token.version)
    if (!declaration || !declaration.methods?.length) throw new RpcFault('SERVICE_NOT_DECLARED', 'Child services require explicit exported methods')
    if (!['ready', 'unavailable', 'degraded'].includes(String(request.readiness))) throw new RpcFault('INVALID_PAYLOAD', 'Invalid readiness')
    const proxy = Object.fromEntries(declaration.methods.map(method => [method, async (...args: JsonValue[]) => {
      context.lifecycle.assertActive()
      return peer.request('services.invoke', { id: token.id, method, args })
    }]))
    registrations.set(token.id, context.services.provide(token, Object.freeze(proxy), request.readiness as 'ready' | 'unavailable' | 'degraded'))
  })
  peer.handle('services.readiness', payload => {
    const request = fields(payload)
    if (!['ready', 'unavailable', 'degraded'].includes(String(request.state))) throw new RpcFault('INVALID_PAYLOAD', 'Invalid readiness')
    const registration = registrations.get(String(request.id))
    if (!registration) throw new RpcFault('SERVICE_NOT_FOUND', String(request.id))
    registration.setReadiness(request.state as 'ready' | 'unavailable' | 'degraded')
  })
  peer.handle('services.remove', async payload => { const id = String(fields(payload).id); await registrations.get(id)?.dispose(); registrations.delete(id) })
  peer.handle('events.emit', async payload => {
    const request = fields(payload)
    return snapshotJson(await context.events.emit(request.event as unknown as EventDefinition<JsonValue>, request.value))
  })
  peer.handle('events.register', payload => {
    const request = fields(payload)
    const id = String(request.id)
    if (listeners.has(id) || listeners.size >= 256) throw new RpcFault('INVALID_REQUEST', 'Event registration limit or conflict')
    const event = request.event as unknown as EventDefinition<JsonValue>
    const remove = request.kind === 'middleware'
      ? context.events.use(event, id, async value => await peer.request('events.dispatch', { id, value }) as unknown as PipelineResult<JsonValue>, request.ordering as unknown as EventMiddlewareOrdering)
      : context.events.on(event, async value => { await peer.request('events.dispatch', { id, value }) })
    listeners.set(id, remove)
  })
  peer.handle('events.remove', async payload => { const id = String(fields(payload).id); await listeners.get(id)?.(); listeners.delete(id) })
  try {
    await peer.ready
    await peer.request('runtime.start', snapshotJson({ identity: context.plugin, entry: options.entry, manifest: options.manifest, config: options.config, policy: options.policy ?? [], grants: options.grants ?? [], services: options.services ?? [] }), { timeoutMs: timeout })
    return Object.freeze({ pid: child.pid!, dispose, reconfigure: async (next: JsonObject, previous: JsonObject) => { await peer.request('runtime.reconfigure', { next, previous }, { timeoutMs: timeout }) } })
  } catch (error) { await dispose(); throw error }
}
