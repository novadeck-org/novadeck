type Reader = { readonly owner: string; finished: boolean; wake: (() => void) | undefined }

/**
 * Whole state, streamed to any number of readers: each reads it now and again after every
 * change. A change is a counter and a wake-up, so any number of changes between two looks is
 * one new state. A slow reader isn't slowed or queued: it reads the state as it is when it
 * next looks.
 */
export class Versioned<State> {
  private readonly readers = new Set<Reader>()
  private readonly throttleMs: number
  private version = 0
  private lastProgress = 0

  /** `throttleMs`: how often `progress` reaches readers, at most. */
  constructor({ throttleMs }: { readonly throttleMs: number }) {
    this.throttleMs = throttleMs
  }

  /** Tells every reader the state changed. */
  changed(): void {
    this.version += 1
    for (const reader of this.readers) reader.wake?.()
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
    const reader: Reader = { owner, finished: false, wake: undefined }
    this.readers.add(reader)
    const stop = () => {
      reader.finished = true
      reader.wake?.()
    }
    signal?.addEventListener("abort", stop, { once: true })
    if (signal?.aborted) stop()
    try {
      let seen = -1
      while (!reader.finished) {
        if (seen !== this.version) {
          seen = this.version
          yield state()
          continue
        }
        // eslint-disable-next-line no-await-in-loop -- Wait for the next change.
        await new Promise<void>((resolve) => {
          reader.wake = resolve
        })
      }
    } finally {
      signal?.removeEventListener("abort", stop)
      this.readers.delete(reader)
    }
  }

  /** Ends an owner's streams, as its connection goes. */
  release(owner: string): void {
    for (const reader of this.readers)
      if (reader.owner === owner) {
        reader.finished = true
        reader.wake?.()
      }
  }

  /** Ends every stream, as the service closes. */
  finish(): void {
    for (const reader of this.readers) {
      reader.finished = true
      reader.wake?.()
    }
  }
}
