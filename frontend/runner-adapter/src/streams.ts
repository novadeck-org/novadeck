// Following the runner's streams: one item's trouble never ends a stream.

/**
 * Logs an error the adapter caught and can do nothing more about, where the page's uncaught
 * errors go: the desktop app's log (it hears the page's `error` events), else the console.
 */
export const reportCaught = (error: unknown): void => {
  if (typeof globalThis.reportError === "function") globalThis.reportError(error)
  else console.error(error)
}

/**
 * Hands each item of `changes` to `handle` until the stream ends. A handler that throws is
 * reported and the next item is handled as usual; the stream's own error, as once the runner
 * closed for good, ends it quietly: the connection store already says so.
 */
export const consume = async <T>(
  changes: AsyncIterable<T>,
  handle: (change: T) => void,
): Promise<void> => {
  try {
    for await (const change of changes)
      try {
        handle(change)
      } catch (error) {
        reportCaught(error)
      }
  } catch {
    // The runner closed for good.
  }
}
