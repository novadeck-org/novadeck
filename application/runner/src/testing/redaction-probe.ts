/// <reference lib="es2024.sharedmemory" />

// Capture these before a test controls the preparer's deadline timers. The worker and
// the setImmediate callback below always run in real time.
const timeout = setTimeout
const clear = clearTimeout

/** Watches slow-worker's hang: entered its loop, main-loop callback, worker saw that callback. */
export const redactionProbe = () => {
  const progress = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2))
  return {
    buffer: progress.buffer,
    observe: async (): Promise<void> => {
      let timer: NodeJS.Timeout | undefined
      let immediate: NodeJS.Immediate | undefined
      const expired = new Promise<never>((_resolve, reject) => {
        timer = timeout(
          () =>
            reject(new Error("The redaction worker did not acknowledge the main-loop callback")),
          5_000,
        )
      })
      try {
        await Promise.race([Atomics.waitAsync(progress, 0, 0, 5_000).value, expired])
        if (Atomics.load(progress, 0) !== 1)
          throw new Error("The redaction worker did not enter its loop")
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            immediate = setImmediate(() => {
              if (Atomics.load(progress, 0) !== 1)
                return reject(
                  new Error("The redaction worker left its loop before the main-loop callback"),
                )
              Atomics.store(progress, 1, 1)
              resolve()
            })
          }),
          expired,
        ])
        await Promise.race([Atomics.waitAsync(progress, 0, 1, 5_000).value, expired])
        if (Atomics.load(progress, 0) !== 2)
          throw new Error("The redaction worker did not see the main-loop callback")
      } finally {
        clear(timer)
        clearImmediate(immediate)
      }
    },
  }
}
