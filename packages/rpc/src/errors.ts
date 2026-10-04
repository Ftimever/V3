import type { RpcErrorCode } from '@easybot/contracts'

export class RpcFault extends Error {
  constructor(readonly code: RpcErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RpcFault'
  }
}
