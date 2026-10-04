import { fileURLToPath } from 'node:url'
import { createPluginLoader } from '../packages/loader/dist/index.js'

const loader = createPluginLoader({ baseDirectory: fileURLToPath(new URL('.', import.meta.url)) })
loader.subscribe(status => console.log(`${status.identity.instanceId}: ${status.state}`))
const permission = { id: 'service:example.counter' }

try {
  await loader.discover({ instanceId: 'counter', source: { kind: 'local', path: './plugins/counter' }, trust: 'trusted' })
  await loader.discover({
    instanceId: 'consumer',
    source: { kind: 'local', path: './plugins/consumer' },
    trust: 'trusted',
    config: { increments: 3 },
    policy: [permission],
    grants: [{ ...permission, instanceId: 'consumer' }],
  })
  await loader.startAll()
} finally {
  await loader.dispose()
}
