#!/usr/bin/env node
import { managementRequest } from '@easybot/management'

export async function runCli(argv: readonly string[], environment: NodeJS.ProcessEnv = process.env, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const [command = 'status', subject] = argv
  const baseUrl = environment.EASYBOT_MANAGEMENT_URL ?? 'http://127.0.0.1:0'
  const token = environment.EASYBOT_MANAGEMENT_TOKEN
  if (!token) throw new Error('EASYBOT_MANAGEMENT_TOKEN is required')
  const client = { baseUrl, token }
  const route = command === 'status' ? '/api/v1/status' : command === 'plugins' ? '/api/v1/plugins' : command === 'groups' ? '/api/v1/groups' : subject && ['start', 'stop', 'rollback'].includes(command) ? `/api/v1/groups/${encodeURIComponent(subject)}/${command}` : undefined
  if (!route) throw new Error('Usage: easybot status|plugins|groups|start <group>|stop <group>|rollback <group>')
  const value = await managementRequest(client, route, command === 'status' || command === 'plugins' || command === 'groups' ? {} : { method: 'POST', body: '{}' })
  output.write(`${JSON.stringify(value, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}`) runCli(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
