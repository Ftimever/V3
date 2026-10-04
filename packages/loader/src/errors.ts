import type { PlatformErrorCode } from '@easybot/contracts'

export class LoaderError extends Error {
  constructor(readonly code: PlatformErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LoaderError'
  }
}
