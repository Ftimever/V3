#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PermissionGrant, PermissionRequest } from '@easybot/contracts'
import { LogBuffer, mountBasePlugins, WebUiRegistry } from '@easybot/base'
import { createManagementServer, type ManagementServer } from '@easybot/management'
import { PackageInstaller, PluginGroupManager } from '@easybot/plugin-group'
import { SecretVault, StateStore } from '@easybot/state'

export interface HostConfig {
  readonly dataDirectory?: string
  readonly stateFile?: string
  readonly deploymentDirectory?: string
  readonly baseDirectory?: string
  readonly masterKeyFile?: string
  readonly logs?: { readonly capacity?: number }
  readonly management?: { readonly host?: string; readonly port?: number; readonly tokenFile?: string; readonly allowedOrigin?: string }
  readonly installer?: { readonly npmCli?: string; readonly registry?: string; readonly timeoutMs?: number }
}
export interface HostOptions { readonly config?: HostConfig; readonly configFile?: string; readonly cwd?: string; readonly environment?: NodeJS.ProcessEnv }
export interface ResolvedHostConfig {
  readonly dataDirectory: string
  readonly stateFile: string
  readonly deploymentDirectory: string
  readonly baseDirectory: string
  readonly masterKeyFile: string
  readonly logs: { readonly capacity: number }
  readonly management: { readonly host: string; readonly port: number; readonly tokenFile: string; readonly allowedOrigin?: string }
  readonly installer: { readonly npmCli?: string; readonly registry?: string; readonly timeoutMs?: number }
}
export interface EasybotHost {
  readonly config: ResolvedHostConfig
  readonly token: string
  readonly tokenSource: 'environment' | 'file' | 'generated'
  readonly store: StateStore
  readonly vault: SecretVault
  readonly logs: LogBuffer
  readonly webui: WebUiRegistry
  readonly groupManager: PluginGroupManager
  readonly management: ManagementServer
  close(): Promise<void>
}
interface TokenRecord { readonly value: string; readonly source: EasybotHost['tokenSource'] }

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function optionalPath(base: string, value: string | undefined, fallback: string): string { return resolve(base, value ?? fallback) }
function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
  return value
}
function resolveConfig(input: HostConfig, base: string, environment: NodeJS.ProcessEnv): ResolvedHostConfig {
  const dataDirectory = resolve(base, environment.EASYBOT_DATA_DIR ?? input.dataDirectory ?? './data')
  const managementInput = input.management ?? {}
  const installerInput = input.installer ?? {}
  const portValue = environment.EASYBOT_MANAGEMENT_PORT === undefined ? managementInput.port : Number(environment.EASYBOT_MANAGEMENT_PORT)
  const port = portValue === undefined ? 27800 : typeof portValue === 'number' && Number.isSafeInteger(portValue) && portValue >= 0 ? portValue : positiveInteger(portValue, 27800, 'management.port')
  if (port > 65535) throw new TypeError('management.port must not exceed 65535')
  const host = environment.EASYBOT_MANAGEMENT_HOST ?? managementInput.host ?? '127.0.0.1'
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new TypeError('Management server only binds approved loopback hosts')
  const capacity = positiveInteger(input.logs?.capacity, 500, 'logs.capacity')
  const timeoutMs = installerInput.timeoutMs === undefined ? undefined : positiveInteger(installerInput.timeoutMs, 120000, 'installer.timeoutMs')
  return Object.freeze({
    dataDirectory, stateFile: optionalPath(dataDirectory, input.stateFile, 'easybot.sqlite'), deploymentDirectory: optionalPath(dataDirectory, input.deploymentDirectory, 'plugins'), baseDirectory: resolve(base, input.baseDirectory ?? '.'), masterKeyFile: optionalPath(dataDirectory, input.masterKeyFile, 'master.key'),
    logs: Object.freeze({ capacity }),
    management: Object.freeze({ host, port, tokenFile: optionalPath(dataDirectory, managementInput.tokenFile, 'management.token'), ...(managementInput.allowedOrigin ? { allowedOrigin: managementInput.allowedOrigin } : {}) }),
    installer: Object.freeze({ ...(installerInput.npmCli ? { npmCli: resolve(base, installerInput.npmCli) } : {}), ...(installerInput.registry ? { registry: installerInput.registry } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
  })
}
async function readConfigFile(path: string, required: boolean): Promise<HostConfig> {
  try { const parsed: unknown = JSON.parse(await readFile(path, 'utf8')); if (!isObject(parsed)) throw new TypeError('Host configuration must be a JSON object'); return parsed as HostConfig } catch (error) { if (!required && error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}; throw error }
}
export async function loadHostConfig(path = resolve(process.cwd(), 'easybot.config.json')): Promise<HostConfig> { return readConfigFile(path, false) }
async function ensurePrivateFile(path: string, contents: string | Uint8Array, mode: number): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents, { mode }); try { await chmod(path, mode) } catch {} }
async function readOrCreateKey(path: string): Promise<Buffer> {
  try { const key = await readFile(path); if (key.byteLength !== 32) throw new TypeError(`Master key must contain 32 bytes: ${path}`); return key } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; const key = randomBytes(32); await ensurePrivateFile(path, key, 0o600); return key }
}
async function readOrCreateToken(path: string, environment: NodeJS.ProcessEnv): Promise<TokenRecord> {
  const fromEnvironment = environment.EASYBOT_MANAGEMENT_TOKEN
  if (fromEnvironment !== undefined) { if (fromEnvironment.length < 24) throw new TypeError('EASYBOT_MANAGEMENT_TOKEN must contain at least 24 characters'); return { value: fromEnvironment, source: 'environment' } }
  try { const value = (await readFile(path, 'utf8')).trim(); if (value.length < 24) throw new TypeError(`Management token file is invalid: ${path}`); return { value, source: 'file' } } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; const value = randomBytes(36).toString('base64url'); await ensurePrivateFile(path, `${value}\n`, 0o600); return { value, source: 'generated' } }
}
function grantsForPolicy(_groupId: string, instanceId: string, policy: readonly PermissionRequest[]): readonly PermissionGrant[] { return policy.map(permission => ({ ...permission, instanceId })) }
function mergeConfig(fileConfig: HostConfig, optionConfig: HostConfig | undefined): HostConfig {
  if (!optionConfig) return fileConfig
  return { ...fileConfig, ...optionConfig, ...(fileConfig.logs || optionConfig.logs ? { logs: { ...fileConfig.logs, ...optionConfig.logs } } : {}), ...(fileConfig.management || optionConfig.management ? { management: { ...fileConfig.management, ...optionConfig.management } } : {}), ...(fileConfig.installer || optionConfig.installer ? { installer: { ...fileConfig.installer, ...optionConfig.installer } } : {}) }
}

export async function createHost(options: HostOptions = {}): Promise<EasybotHost> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const configPath = options.configFile ? resolve(cwd, options.configFile) : resolve(cwd, 'easybot.config.json')
  const fileConfig = await readConfigFile(configPath, Boolean(options.configFile))
  const config = resolveConfig(mergeConfig(fileConfig, options.config), dirname(configPath), options.environment ?? process.env)
  await mkdir(config.dataDirectory, { recursive: true })
  const environment = options.environment ?? process.env
  const token = await readOrCreateToken(config.management.tokenFile, environment)
  const key = await readOrCreateKey(config.masterKeyFile)
  const store = new StateStore(config.stateFile)
  const vault = new SecretVault(store, key)
  const logs = new LogBuffer(config.logs.capacity)
  const webui = new WebUiRegistry()
  const installer = new PackageInstaller({ root: config.deploymentDirectory, ...config.installer })
  const groupManager = new PluginGroupManager({ store, installer, loader: { baseDirectory: config.baseDirectory, logger: logs.logger }, grants: grantsForPolicy, bootstrap: async (loader, groupId) => { await mountBasePlugins(loader.kernel, { store, vault, logs, webui }, groupId) } })
  try {
    try { await groupManager.restore() } catch (error) { logs.logger.warn('Some plugin groups failed to restore', { error: error instanceof Error ? error.message : String(error) }) }
    const management = await createManagementServer({ groupManager, webui, token: token.value, host: config.management.host, port: config.management.port, ...(config.management.allowedOrigin ? { allowedOrigin: config.management.allowedOrigin } : {}) })
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => {
      closing ??= (async () => { const errors: unknown[] = []; for (const action of [() => management.close(), () => groupManager.dispose(), () => { store.close() }]) { try { await action() } catch (error) { errors.push(error) } } if (errors.length) throw new AggregateError(errors, 'Host shutdown failed') })()
      return closing
    }
    return Object.freeze({ config, token: token.value, tokenSource: token.source, store, vault, logs, webui, groupManager, management, close })
  } catch (error) { await groupManager.dispose().catch(() => {}); store.close(); throw error }
}

export async function runHost(options: HostOptions = {}, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const host = await createHost(options)
  output.write(`Easybot host listening at ${host.management.address}\n`)
  if (host.tokenSource === 'generated') output.write(`Management token (save it): ${host.token}\n`)
  output.write('Press Ctrl+C to stop.\n')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let stopping: Promise<void> | undefined
    const onInterrupt = (): void => shutdown('SIGINT')
    const onTerminate = (): void => shutdown('SIGTERM')
    const cleanup = (): void => { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate) }
    const shutdown = (signal: string): void => { if (stopping) return; stopping = host.close().then(() => { cleanup(); output.write(`Easybot host stopped (${signal}).\n`); resolvePromise() }, error => { cleanup(); rejectPromise(error) }) }
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate)
  })
}
function parseArgs(argv: readonly string[]): HostOptions { const command = argv[0] ?? 'start'; if (command !== 'start') throw new Error('Usage: easybot-host start [--config <path>]'); const configIndex = argv.indexOf('--config'); if (configIndex === -1) return {}; const configFile = argv[configIndex + 1]; if (!configFile) throw new Error('--config requires a path'); return { configFile } }
const entry = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === entry) runHost(parseArgs(process.argv.slice(2))).catch(error => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1 })
