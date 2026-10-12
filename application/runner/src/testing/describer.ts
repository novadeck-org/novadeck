import type { Describer, Description, Digest } from "../murmur/describer.js"

/** One call to a fake describer: the digest and signal it was given, and a way to answer it. */
export type FakeJob = {
  readonly digest: Digest
  readonly signal: AbortSignal | undefined
  /** The terminal it was asked for. */
  readonly terminal: string | undefined
  /** Answers a held call; a call aborted meanwhile answers undefined on its own. */
  readonly answer: (description: Description | null | undefined) => void
}

/**
 * A describer as terminal tests drive one: every call is recorded in `jobs`, answered at
 * once with what `reply` makes of the digest (a numbered title, by default), or, with `hold`, left until a test answers it. A call aborted
 * answers undefined, as the real one does.
 */
export class FakeDescriber implements Describer {
  readonly jobs: FakeJob[] = []
  /** Whether calls are held for the test to answer. */
  hold = false
  private usable: boolean
  private readonly listeners = new Set<(usable: boolean) => void>()
  private readonly clearedListeners = new Set<() => void>()

  constructor(
    options: {
      readonly usable?: boolean
      readonly reply?: (digest: Digest, call: number) => Description | null | undefined
    } = {},
  ) {
    this.usable = options.usable ?? true
    this.reply = options.reply ?? ((_digest, call) => ({ title: `Title ${call}` }))
  }

  private readonly reply: (digest: Digest, call: number) => Description | null | undefined

  describe(
    digest: Digest,
    options: { readonly signal?: AbortSignal; readonly terminal?: string } = {},
  ): Promise<Description | null | undefined> {
    const { signal, terminal } = options
    const call = this.jobs.length + 1
    if (!this.usable) {
      this.jobs.push({ digest, signal, terminal, answer: () => {} })
      return Promise.resolve(undefined)
    }
    return new Promise((resolve) => {
      const answer = (description: Description | null | undefined) => resolve(description)
      this.jobs.push({ digest, signal, terminal, answer })
      signal?.addEventListener("abort", () => resolve(undefined), { once: true })
      if (!this.hold) resolve(this.reply(digest, call))
    })
  }

  watchUsable(listener: (usable: boolean) => void): () => void {
    this.listeners.add(listener)
    // As the real service does: the state now, then each change.
    listener(this.usable)
    return () => this.listeners.delete(listener)
  }

  watchCleared(listener: () => void): () => void {
    this.clearedListeners.add(listener)
    return () => this.clearedListeners.delete(listener)
  }

  /** The person turns murmur off or removes it: it stops being usable, and titles are cleared. */
  clear(): void {
    this.setUsable(false)
    this.fireCleared()
  }

  /** Only the clearing, with usability as it is: what a listener does for it by itself. */
  fireCleared(): void {
    for (const listener of this.clearedListeners) listener()
  }

  /** Murmur becomes usable, or stops being. */
  setUsable(usable: boolean): void {
    this.usable = usable
    for (const listener of this.listeners) listener(usable)
  }

  /** The digests it was given, oldest first. */
  get digests(): readonly Digest[] {
    return this.jobs.map(({ digest }) => digest)
  }
}
