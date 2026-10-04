import { CoreError } from './errors.js'

export type Dispose = () => void | Promise<void>

export class LifecycleScope {
  private readonly disposers = new Set<Dispose>()
  private pending?: Promise<void>

  get disposed(): boolean {
    return this.pending !== undefined
  }

  assertActive(): void {
    if (this.disposed) throw new CoreError('SCOPE_DISPOSED', 'Plugin scope has been disposed')
  }

  add(dispose: Dispose): Dispose {
    this.assertActive()
    let pending: Promise<void> | undefined
    const once = (): Promise<void> => {
      if (!pending) {
        this.disposers.delete(once)
        pending = Promise.resolve().then(dispose)
      }
      return pending
    }
    this.disposers.add(once)
    return once
  }

  dispose(): Promise<void> {
    if (!this.pending) {
      const disposers = [...this.disposers].reverse()
      this.disposers.clear()
      this.pending = Promise.resolve().then(async () => {
        const errors: unknown[] = []
        for (const dispose of disposers) {
          try {
            await dispose()
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Resource cleanup failed')
      })
    }
    return this.pending
  }
}
