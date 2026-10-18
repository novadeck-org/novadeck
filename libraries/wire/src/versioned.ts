type Watch = { readonly owner: string; finished: boolean; wake: (() => void) | undefined }

/**
 * Whole state, streamed to whoever watches it: each watcher hears it now and again after
 * every change. A change is a counter and a wake-up, so any number of changes between two
 * looks is one new state. A slow watcher isn't slowed or queued: it reads the state as it
 * is when it next looks.
 */
export class Versioned<State> {
  private readonly watchers = new Set<Watch>()
  private readonly throttleMs: number
  private version = 0
  private lastProgress = 0

  /** `throttleMs`: how often `progress` reaches watchers, at most. */
  constructor({ throttleMs }: { readonly throttleMs: number }) {
    this.throttleMs = throttleMs
  }

  /** Tells every watcher the state changed. */
  changed(): void {
    this.version += 1
    for (const watch of this.watchers) watch.wake?.()
  }

  /** A change in progress: told at most once every `throttleMs` unless `force`. */
  progress(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastProgress < this.throttleMs) return
    this.lastProgress = now
    this.changed()
  }

  /** The state now, then again after each change, until `signal` aborts or the owner is released. */
  async *stream(owner: string, state: () => State, signal?: AbortSignal): AsyncGenerator<State> {
    const watch: Watch = { owner, finished: false, wake: undefined }
    this.watchers.add(watch)
    const stop = () => {
      watch.finished = true
      watch.wake?.()
    }
    signal?.addEventListener("abort", stop, { once: true })
    if (signal?.aborted) stop()
    try {
      let seen = -1
      while (!watch.finished) {
        if (seen !== this.version) {
          seen = this.version
          yield state()
          continue
        }
        // eslint-disable-next-line no-await-in-loop -- Wait for the next change.
        await new Promise<void>((resolve) => {
          watch.wake = resolve
        })
      }
    } finally {
      signal?.removeEventListener("abort", stop)
      this.watchers.delete(watch)
    }
  }

  /** Ends an owner's streams, as its connection goes. */
  release(owner: string): void {
    for (const watch of this.watchers)
      if (watch.owner === owner) {
        watch.finished = true
        watch.wake?.()
      }
  }

  /** Ends every stream, as the service closes. */
  finish(): void {
    for (const watch of this.watchers) {
      watch.finished = true
      watch.wake?.()
    }
  }
}
