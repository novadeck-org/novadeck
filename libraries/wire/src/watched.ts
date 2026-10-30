const done = { value: undefined, done: true } as const

/** A value with an async stream of its changes. */
export class Watched<T> {
  private wake = () => {}
  private changed = new Promise<void>((resolve) => {
    this.wake = resolve
  })

  constructor(
    private current: T,
    private readonly final: (value: T) => boolean,
  ) {}

  get value(): T {
    return this.current
  }

  set(value: T): void {
    this.current = value
    const wake = this.wake
    this.changed = new Promise((resolve) => {
      this.wake = resolve
    })
    wake()
  }

  /** Resolves on the next change; reading `value` afterwards gives the latest one. */
  next(): Promise<void> {
    return this.changed
  }

  /**
   * Iterates the latest values, ending after a final one. Quick successive changes may be
   * coalesced. Unlike a generator, `return()` also ends a pending wait.
   */
  watch(): AsyncIterableIterator<T, undefined> {
    let last: { value: T } | undefined
    let stop: (() => void) | undefined
    const stopped = new Promise<typeof done>((resolve) => {
      stop = () => resolve(done)
    })
    let active = true
    const iterator: AsyncIterableIterator<T, undefined> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async () => {
        if (last && this.final(last.value)) active = false
        if (active && last?.value === this.current) {
          await Promise.race([this.changed, stopped])
        }
        if (!active) return done
        last = { value: this.current }
        return { value: this.current, done: false }
      },
      return: () => {
        active = false
        stop?.()
        return Promise.resolve(done)
      },
    }
    return iterator
  }
}

/** A value and its changes, read-only: `value`, `next()` for the next change, and `watch()`. */
export type Watching<T> = Pick<Watched<T>, "value" | "next" | "watch">
