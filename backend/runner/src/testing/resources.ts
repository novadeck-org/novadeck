// The real clock: a test's fake one replaces only the global timers, so the bound on its
// cleanups still runs out while they wait on a timer it faked.
import { clearTimeout, setTimeout } from "node:timers"

// How long one cleanup may take, in milliseconds: as long as a hook may (vitest.config.ts).
// Vitest gives a fixture's teardown no time limit, so a cleanup that never ends hangs the
// whole run without a word.
const cleanupMs = 20_000

type Cleanup = { run: () => void | Promise<void>; name: string }

/** Per-test ownership, with every cleanup attempted even when an earlier one fails. */
export class Resources {
  private readonly cleanups: Cleanup[] = []

  constructor(private readonly options: { cleanupMs?: number } = {}) {}

  /** Runs `cleanup` at disposal; `name` says what it waited on should it not end in time. */
  defer(cleanup: () => void | Promise<void>, name = described(cleanup)): void {
    this.cleanups.push({ run: cleanup, name })
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = []
    for (const cleanup of this.cleanups.splice(0).toReversed()) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Release dependents before their backing resources.
        await this.bounded(cleanup)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Test resource cleanup failed")
  }

  private async bounded({ run, name }: Cleanup): Promise<void> {
    const ms = this.options.cleanupMs ?? cleanupMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Test cleanup did not end within ${ms} ms: ${name}`)),
        ms,
      )
    })
    try {
      await Promise.race([run(), late])
    } finally {
      clearTimeout(timer)
    }
  }
}

// A cleanup's first line of source, which names what it waits on, as `() => manager.shutdown()`.
const described = (cleanup: () => unknown): string => {
  const source = cleanup.toString().split("\n", 1)[0]!.trim()
  return source.length > 80 ? `${source.slice(0, 80)}…` : source
}
