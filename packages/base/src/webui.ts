import { snapshotJson, type PluginContext } from '@easybot/contracts'
import type { WebUiContribution, WebUiService, WebUiTheme } from './tokens.js'

export class WebUiRegistry {
  private readonly contributions = new Map<string, WebUiContribution & { instanceId: string; groupId?: string }>()
  private readonly themes = new Map<string, WebUiTheme>()
  list() { return [...this.contributions.values()] }
  tokens(): WebUiTheme { return [...this.themes.values()].at(-1) ?? { accent: 'mint', density: 'comfortable' } }
  forPlugin(context: PluginContext): WebUiService {
    const prefix = `${encodeURIComponent(context.plugin.groupId ?? 'global')}/${encodeURIComponent(context.plugin.instanceId)}`
    const owned = new Set<string>()
    context.lifecycle.add(() => { for (const id of owned) this.contributions.delete(id); this.themes.delete(prefix) })
    return Object.freeze({
      register: async (input: WebUiContribution) => {
        context.capabilities.require('webui:contribute')
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.id) || !['status-card', 'info-card', 'log-panel'].includes(input.component)) throw new TypeError('Invalid declarative WebUI contribution')
        if (input.route && !input.route.startsWith(`/plugins/${encodeURIComponent(context.plugin.instanceId)}/`)) throw new TypeError('WebUI routes must be instance namespaced')
        if (owned.size >= 32 && !owned.has(`${prefix}/${input.id}`)) throw new TypeError('WebUI contribution limit exceeded')
        const contribution = snapshotJson(input) as unknown as WebUiContribution
        if (Buffer.byteLength(JSON.stringify(contribution)) > 16384) throw new TypeError('WebUI contribution too large')
        const id = `${prefix}/${input.id}`
        this.contributions.set(id, Object.freeze({ ...contribution, id, instanceId: context.plugin.instanceId, ...(context.plugin.groupId ? { groupId: context.plugin.groupId } : {}) }))
        owned.add(id)
        return id
      },
      remove: async (id: string) => { context.lifecycle.assertActive(); if (!owned.has(id)) throw new TypeError('Contribution belongs to another instance'); owned.delete(id); this.contributions.delete(id) },
      theme: async (tokens: WebUiTheme) => {
        context.capabilities.require('webui:theme', { slot: 'theme' })
        if (!['mint', 'amber', 'blue'].includes(tokens.accent) || !['comfortable', 'compact'].includes(tokens.density)) throw new TypeError('Invalid theme tokens')
        this.themes.delete(prefix)
        this.themes.set(prefix, Object.freeze({ accent: tokens.accent, density: tokens.density }))
      },
    })
  }
}
