import { relative, sep } from "node:path"
// The real clock: a test's fake one replaces only the global timers, so the bound on its
// cleanups still runs out while they wait on a timer it faked.
import { clearTimeout, setTimeout } from "node:timers"

// How long one cleanup may take, in milliseconds, unless the test's config says (src/test.ts).
// Vitest gives a fixture's teardown no time limit, so a cleanup that never ends hangs the
// whole run without a word.
const cleanupMs = 20_000

type Cleanup = { run: () => void | Promise<void>; name: string; deferred: Error }

/** Per-test ownership, with every cleanup attempted even when an earlier one fails. */
export class Resources {
  private readonly cleanups: Cleanup[] = []

  constructor(private readonly options: { cleanupMs?: number } = {}) {}

  /**
   * Runs `cleanup` at disposal. Should it not end in time, its failure names it by `name`,
   * else by its first line of source, and by where it was deferred.
   */
  defer(cleanup: () => void | Promise<void>, name = firstLine(cleanup)): void {
    this.cleanups.push({ run: cleanup, name, deferred: new Error("deferred") })
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

  private async bounded({ run, name, deferred }: Cleanup): Promise<void> {
    const ms = this.options.cleanupMs ?? cleanupMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const where = deferredAt(deferred)
        const at = where ? `, deferred at ${where}` : ""
        reject(new Error(`Test cleanup did not end within ${ms} ms: ${name}${at}`))
      }, ms)
    })
    try {
      await Promise.race([run(), late])
    } finally {
      clearTimeout(timer)
    }
  }
}

const firstLine = (cleanup: () => unknown): string => {
  const source = cleanup.toString().split("\n", 1)[0]!.trim()
  return source.length > 80 ? `${source.slice(0, 80)}…` : source
}

// The file and line that called `defer`, from the stack taken there: past its own frame.
// Written with forward slashes, as on every system.
const deferredAt = (deferred: Error): string | undefined => {
  const frame = deferred.stack?.split("\n")[2]
  const location = frame?.match(/\(?(?:file:\/\/)?([^\s()]+:\d+):\d+\)?$/)?.[1]
  return location && relative(process.cwd(), location).split(sep).join("/")
}
