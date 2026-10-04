import type { PlatformErrorCode } from '@easybot/contracts'

export type CoreErrorCode = PlatformErrorCode

export class CoreError extends Error {
  constructor(readonly code: CoreErrorCode, message: string) {
    super(message)
    this.name = 'CoreError'
  }
}
