const noop = (): void => {}

/**
 * Waits for `promise`, or resolves undefined as soon as `signal` aborts. Each wait listens on
 * its own and stops after, so a long run of waits on one signal leaves nothing behind.
 */
export const until = async <V>(
  promise: Promise<V>,
  signal: AbortSignal,
): Promise<V | undefined> => {
  if (signal.aborted) return undefined
  let stop: () => void = noop
  const stopped = new Promise<undefined>((resolve) => {
    stop = () => resolve(undefined)
  })
  signal.addEventListener("abort", stop, { once: true })
  try {
    return await Promise.race([promise, stopped])
  } finally {
    signal.removeEventListener("abort", stop)
  }
}
