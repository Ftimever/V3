import { readFile, writeFile } from 'node:fs/promises'
import { compile } from 'json-schema-to-typescript'

const schemas = [
  ['plugin-manifest.v1', 'WirePluginManifest'],
  ['plugin-group.v1', 'WirePluginGroupManifest'],
  ['rpc-envelope.v1', 'WireRpcEnvelope'],
]
const runtimeSchemas = []
async function saveGenerated(target, output) {
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== output) throw new Error(`Stale generated contract: ${target.pathname}`)
  } else {
    await writeFile(target, output)
  }
}
for (const [name, typeName] of schemas) {
  const source = new URL(`../schemas/${name}.json`, import.meta.url)
  const schema = JSON.parse(await readFile(source, 'utf8'))
  const exportName = typeName.replace(/^Wire/, '')
  runtimeSchemas.push(`export const ${exportName[0].toLowerCase()}${exportName.slice(1)}Schema: Record<string, unknown> = ${JSON.stringify(schema, null, 2)}\n`)
  const output = await compile({ ...schema, title: typeName }, typeName, {
    bannerComment: '',
    style: { semi: false, singleQuote: true },
    additionalProperties: false,
  })
  const target = new URL(`../packages/contracts/src/${name}.ts`, import.meta.url)
  await saveGenerated(target, output)
}
await saveGenerated(new URL('../packages/contracts/src/schemas.ts', import.meta.url), runtimeSchemas.join('\n'))
