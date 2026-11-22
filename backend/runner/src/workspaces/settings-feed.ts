import type { PreferenceChange, RunnerSettingsState } from "@novadeck/protocol"
import { Latest } from "@novadeck/wire/server"

// The person's settings as they change, for every client they use (`settings.watch`,
// `preferences.watch`): each device follows what another changed, live.

/** One reader's preference changes, merged key by key while it hasn't read them. */
class PreferenceReader {
  private pending: PreferenceChange | undefined
  private finished = false
  private wake: (() => void) | undefined

  constructor(first: PreferenceChange) {
    this.pending = first
  }

  push(change: PreferenceChange): void {
    if (this.finished) return
    const earlier = this.pending
    this.pending = earlier
      ? {
          values: { ...earlier.values, ...change.values },
          revision: change.revision,
          // Folded with another's change, it is no longer one client's alone.
          writer: earlier.writer === change.writer ? change.writer : null,
        }
      : change
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  finish(): void {
    this.finished = true
    this.pending = undefined
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  async next(): Promise<PreferenceChange | undefined> {
    while (!this.finished && this.pending === undefined)
      // eslint-disable-next-line no-await-in-loop -- Waits for the next change.
      await new Promise<void>((resolve) => (this.wake = resolve))
    const next = this.pending
    this.pending = undefined
    return next
  }
}

/**
 * Streams until `signal` aborts, starting `first`, through a reader `readers` holds
 * meanwhile, so whatever is pushed to it reaches this client.
 */
const follow = async function* <T>(
  readers: Set<{ finish(): void; next(): Promise<T | undefined> }>,
  reader: { finish(): void; next(): Promise<T | undefined> },
  signal: AbortSignal,
): AsyncGenerator<T> {
  readers.add(reader)
  const stop = () => reader.finish()
  signal.addEventListener("abort", stop, { once: true })
  try {
    while (!signal.aborted) {
      // eslint-disable-next-line no-await-in-loop -- Changes are read in order.
      const next = await reader.next()
      if (next === undefined) return
      yield next
    }
  } finally {
    signal.removeEventListener("abort", stop)
    readers.delete(reader)
    reader.finish()
  }
}

/** The person's preferences as they change (`preferences.watch`). */
export class PreferenceFeed {
  private readonly readers = new Set<PreferenceReader>()

  constructor(private readonly current: () => PreferenceChange) {}

  /** Tells every reader the preference changed, as `writer` changed it. */
  changed(key: string, value: string | null, revision: number, writer: string): void {
    for (const reader of this.readers) reader.push({ values: { [key]: value }, revision, writer })
  }

  /** One client's stream: every preference, then each change, until `signal` aborts. */
  watch(signal: AbortSignal): AsyncGenerator<PreferenceChange> {
    return follow(this.readers, new PreferenceReader(this.current()), signal)
  }
}

/** The runner's settings as they change (`settings.watch`): a slow reader gets the latest. */
export class SettingsFeed {
  private readonly readers = new Set<Latest<RunnerSettingsState>>()

  constructor(private readonly current: () => Promise<RunnerSettingsState>) {}

  /** Tells every reader the settings as they are now. */
  async changed(): Promise<void> {
    if (this.readers.size === 0) return
    const settings = await this.current()
    const key = JSON.stringify(settings)
    for (const reader of this.readers) reader.push(settings, key)
  }

  /** One client's stream: the settings now, then as they change, until `signal` aborts. */
  async *watch(signal: AbortSignal): AsyncGenerator<RunnerSettingsState> {
    const reader = new Latest<RunnerSettingsState>()
    // Listening before reading, so a change meanwhile isn't missed.
    this.readers.add(reader)
    try {
      reader.push(await this.current())
    } catch (error) {
      this.readers.delete(reader)
      throw error
    }
    yield* follow(this.readers, reader, signal)
  }
}
