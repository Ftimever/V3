import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(exec)
const packages = await readdir(new URL('../packages/', import.meta.url), { withFileTypes: true })
const failures = []
for (const entry of packages.filter(item => item.isDirectory())) {
  const directory = new URL(`../packages/${entry.name}/`, import.meta.url)
  const packageJson = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'))
  if (!packageJson.exports?.['.']?.types || !packageJson.exports?.['.']?.import) failures.push(`${packageJson.name}: missing typed ESM export`)
  try {
    const { stdout } = await run('pnpm pack --dry-run', { cwd: fileURLToPath(directory), maxBuffer: 2 * 1024 * 1024 })
    if (!stdout.includes('dist/')) failures.push(`${packageJson.name}: dry-run tarball has no dist output`)
  } catch (error) { failures.push(`${packageJson.name}: pack dry-run failed: ${error.message}`) }
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 } else console.log(`release-check: ${packages.filter(item => item.isDirectory()).length} packages validated`)
