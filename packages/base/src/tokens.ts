import type { JsonObject, JsonValue, ServiceToken } from '@easybot/contracts'

export interface StorageService {
  get(key: string): Promise<{ revision: number; value: JsonValue } | null>
  put(key: string, value: JsonValue, revision: number): Promise<{ revision: number; value: JsonValue }>
  delete(key: string, revision: number): Promise<void>
  keys(): Promise<readonly string[]>
}
export interface SecretService { get(id: string): Promise<string | null>; set(id: string, value: string): Promise<void>; delete(id: string): Promise<void> }
export interface HttpRequest { readonly url: string; readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string; readonly timeoutMs?: number }
export interface HttpService { request(input: HttpRequest): Promise<{ status: number; headers: Readonly<Record<string, string>>; text: string }> }
export interface WebSocketService { connect(url: string): Promise<string>; send(id: string, text: string): Promise<void>; receive(id: string, timeoutMs?: number): Promise<string>; close(id: string): Promise<void> }
export interface WebUiContribution { readonly id: string; readonly component: 'status-card' | 'info-card' | 'log-panel'; readonly title?: string; readonly props?: JsonObject; readonly route?: string }
export interface WebUiTheme { readonly accent: 'mint' | 'amber' | 'blue'; readonly density: 'comfortable' | 'compact' }
export interface WebUiService { register(contribution: WebUiContribution): Promise<string>; remove(id: string): Promise<void>; theme(tokens: WebUiTheme): Promise<void> }
export interface LogService { write(level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal', message: string, fields?: JsonObject): Promise<void> }

const token = <Service>(id: string, methods: string[]): ServiceToken<Service> => Object.freeze({ id: `base.${id}`, version: '1.0.0', methods: Object.freeze(methods) })
export const storage = token<StorageService>('storage', ['get', 'put', 'delete', 'keys'])
export const secrets = token<SecretService>('secrets', ['get', 'set', 'delete'])
export const http = token<HttpService>('http', ['request'])
export const websocket = token<WebSocketService>('websocket', ['connect', 'send', 'receive', 'close'])
export const webui = token<WebUiService>('webui', ['register', 'remove', 'theme'])
export const log = token<LogService>('log', ['write'])
