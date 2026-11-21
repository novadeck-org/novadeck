// Asking a window's page to send what it changed in its project to the runner, and waiting for
// its answer: a swap reads a project only once the window that showed it has sent its edits.
// The wait is bounded, so a window that went away or hangs holds no swap up for long.

/** How long a swap waits for a window's answer at most. */
export const flushWaitMs = 2_000

export const createFlushes = <Window>({
  send,
  later,
  nextId,
}: {
  /** Tells the window's page to flush, with the id its answer carries; false when it can't hear. */
  readonly send: (window: Window, id: string) => boolean
  /** Runs `run` after `ms`; returns the cancel. */
  readonly later: (run: () => void, ms: number) => () => void
  readonly nextId: () => string
}) => {
  const waiting = new Map<string, () => void>()
  return {
    /** Resolves once the window's page answered, or after `flushWaitMs`, or at once if it can't hear. */
    ask: (window: Window): Promise<void> =>
      new Promise((resolve) => {
        const id = nextId()
        if (!send(window, id)) return resolve()
        const done = (): void => {
          cancel()
          waiting.delete(id)
          resolve()
        }
        const cancel = later(done, flushWaitMs)
        waiting.set(id, done)
      }),
    /** A page answered an ask. */
    answered: (id: string): void => waiting.get(id)?.(),
  }
}
