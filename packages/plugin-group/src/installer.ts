import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, readdir, stat, writeFile, copyFile, access } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { validRange } from 'semver'
import { discoverPlugin, LoaderError, type PluginSource } from '@easybot/loader'

export interface PackageSnapshot {
  readonly id: string
  readonly source: PluginSource
  readonly directory: string
  readonly rootDirectory: string
  readonly packageName: string
  readonly version: string
  readonly integrity: string
}
export interface InstallerOptions { readonly root: string; readonly npmCli?: string; readonly registry?: string; readonly timeoutMs?: number }

function inside(root: string, path: string): boolean {
  const delta = relative(root, path)
  return delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta)
}

async function npmCli(explicit?: string): Promise<string> {
  const candidates = explicit ? [resolve(explicit)] : [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
  for (const candidate of candidates) { try { await access(candidate); return candidate } catch {} }
  throw new LoaderError('PLUGIN_UNAVAILABLE', 'npm-cli.js not found; configure npmCli explicitly')
}

export async function directoryIntegrity(root: string): Promise<string> {
  const hash = createHash('sha256')
  const boundary = await realpath(root)
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new LoaderError('INVALID_MANIFEST', 'Deployment snapshots cannot contain symlinks')
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const bytes = await readFile(path)
        const name = relative(boundary, path).split(sep).join('/')
        hash.update(JSON.stringify([name, bytes.length])).update('\0').update(bytes)
      }
    }
  }
  await visit(boundary)
  return `sha256-${hash.digest('base64')}`
}

export class PackageInstaller {
  readonly root: string
  constructor(private readonly options: InstallerOptions) { this.root = resolve(options.root) }

  async verify(snapshot: PackageSnapshot): Promise<void> {
    const root = await realpath(this.root)
    const directory = await realpath(snapshot.rootDirectory)
    if (!inside(root, directory) || directory === root || !inside(directory, await realpath(snapshot.directory)) || await directoryIntegrity(directory) !== snapshot.integrity) throw new LoaderError('INVALID_MANIFEST', 'Deployment integrity mismatch or path escape')
  }

  async snapshot(source: PluginSource): Promise<PackageSnapshot> {
    const metadata = structuredClone(source)
    if (metadata.kind === 'npm' && (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(metadata.packageName) || metadata.packageName.length > 214 || !validRange(metadata.version ?? '*'))) throw new LoaderError('INVALID_MANIFEST', 'Only npm names and SemVer selectors are accepted')
    if (!['local', 'npm'].includes(metadata.kind)) throw new LoaderError('INVALID_MANIFEST', 'Only local directories and npm sources are accepted')
    await mkdir(this.root, { recursive: true })
    const id = randomUUID()
    const staging = join(await realpath(this.root), id)
    await mkdir(staging)
    let directory = staging
    if (metadata.kind === 'local') {
      const origin = await realpath(resolve(metadata.path))
      if (inside(origin, staging)) throw new LoaderError('INVALID_MANIFEST', 'Snapshot root cannot be inside plugin source')
      const copy = async (from: string, to: string): Promise<void> => {
        for (const entry of await readdir(from, { withFileTypes: true })) {
          if (['node_modules', '.git', '.idea'].includes(entry.name)) continue
          const path = join(from, entry.name)
          if (entry.isSymbolicLink()) throw new LoaderError('INVALID_MANIFEST', 'Local plugin source contains a symlink')
          if (entry.isDirectory()) { await mkdir(join(to, entry.name)); await copy(path, join(to, entry.name)) }
          else if (entry.isFile()) await copyFile(path, join(to, entry.name))
        }
      }
      await copy(origin, staging)
      const manifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as { dependencies?: object; optionalDependencies?: object }
      if (Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.optionalDependencies ?? {}).length) await this.install(staging)
    } else {
      await writeFile(join(staging, 'package.json'), JSON.stringify({ private: true, name: `easybot-deployment-${id}`, version: '1.0.0' }))
      await this.install(staging, `${metadata.packageName}@${metadata.version ?? '*'}`)
      directory = join(staging, 'node_modules', metadata.packageName)
    }
    const discovered = await discoverPlugin({ instanceId: 'snapshot-check', source: { kind: 'local', path: directory }, trust: 'trusted' }, directory).catch(async error => {
      if (!(error instanceof LoaderError) || error.code !== 'INVALID_CONFIG') throw error
      const packageJson = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name: string; version: string }
      return { identity: { packageName: packageJson.name, version: packageJson.version } }
    })
    const integrityRoot = metadata.kind === 'npm' ? staging : directory
    const integrity = await directoryIntegrity(integrityRoot)
    return Object.freeze({ id, source: Object.freeze(metadata), directory, rootDirectory: integrityRoot, packageName: discovered.identity.packageName, version: discovered.identity.version, integrity })
  }

  private async install(directory: string, selector?: string): Promise<void> {
    const cli = await npmCli(this.options.npmCli)
    const args = [cli, 'install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--package-lock=true', ...(this.options.registry ? ['--registry', this.options.registry] : []), ...(selector ? [selector] : [])]
    const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
    await new Promise<void>((resolveInstall, reject) => {
      const child = spawn(process.execPath, args, { env: { ...environment, npm_config_ignore_scripts: 'true' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      const capture = (bytes: Buffer): void => { output = (output + bytes.toString('utf8')).slice(-65536) }
      child.stdout.on('data', capture); child.stderr.on('data', capture)
      const timer = setTimeout(() => { child.kill(); reject(new LoaderError('REQUEST_TIMEOUT', 'npm installation timed out')) }, this.options.timeoutMs ?? 120000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); if (code === 0) resolveInstall(); else reject(new LoaderError('PLUGIN_UNAVAILABLE', `npm install failed: ${output}`)) })
    })
    if (!(await stat(join(directory, 'package-lock.json'))).isFile()) throw new LoaderError('INVALID_MANIFEST', 'npm did not produce a deployment lockfile')
  }
}
