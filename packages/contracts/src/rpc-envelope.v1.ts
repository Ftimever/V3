export type WireRpcEnvelope = {
  protocol: 'easybot.rpc'
  version: 1
  type: 'request' | 'response' | 'notification' | 'stream' | 'cancel' | 'hello' | 'hello-ack'
  pluginInstanceId?: string
  traceId?: string
  deadline?: number
  capability?: string
  id?: string
  method?: string
  payload?: Json
  ok?: boolean
  error?: Error
  reason?: string
  stream?: 'open' | 'chunk' | 'close'
  capabilities?: Capabilities
} & (
  | {
      type?: 'request'
    }
  | {
      type?: 'response'
      ok: true
    }
  | {
      type?: 'response'
      ok: false
    }
  | {
      type?: 'notification'
    }
  | {
      type?: 'stream'
    }
  | {
      type?: 'cancel'
    }
  | {
      type?: 'hello' | 'hello-ack'
    }
)
export type Json =
  | (string | number | boolean | null)
  | Json[]
  | {
      [k: string]: Json
    }

export interface Error {
  code:
    | 'MANIFEST_MISMATCH'
    | 'INSTANCE_CONFLICT'
    | 'SCOPE_DISPOSED'
    | 'RUNTIME_DISPOSED'
    | 'SERVICE_NOT_DECLARED'
    | 'EVENT_NOT_DECLARED'
    | 'MIDDLEWARE_CONFLICT'
    | 'MIDDLEWARE_CYCLE'
    | 'RETRY_NOT_ALLOWED'
    | 'CAPABILITY_NOT_DECLARED'
    | 'CAPABILITY_NOT_GRANTED'
    | 'SERVICE_NOT_READY'
    | 'SERVICE_NOT_FOUND'
    | 'METHOD_NOT_FOUND'
    | 'PERMISSION_DENIED'
    | 'REQUEST_TIMEOUT'
    | 'PLUGIN_UNAVAILABLE'
    | 'INVALID_REQUEST'
    | 'INVALID_PAYLOAD'
    | 'REQUEST_CANCELLED'
    | 'PROTOCOL_MISMATCH'
    | 'INVALID_MANIFEST'
    | 'INVALID_CONFIG'
    | 'DEPENDENCY_NOT_FOUND'
    | 'DEPENDENCY_CYCLE'
    | 'VERSION_MISMATCH'
    | 'SERVICE_CONFLICT'
    | 'INVALID_LIFECYCLE_STATE'
    | 'PLUGIN_START_FAILED'
    | 'PLUGIN_STOP_FAILED'
    | 'DISPOSE_FAILED'
    | 'INTERNAL_ERROR'
  message: string
  data?: Json
}
export interface Capabilities {
  services?: Reference[]
  events?: Reference[]
  capabilities?: string[]
  features?: string[]
}
export interface Reference {
  id: string
  version: string
}
