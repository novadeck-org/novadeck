// Test support: a stream the test feeds, which the code under test reads as it would one of
// the runner's. It yields what is pushed and throws what fails, in order, and is done once
// it ends; `returned` counts how often its reader let go of it.
export const channel = <T>() => {
  const queued: ({ readonly value: T } | { readonly error: unknown })[] = []
  let ended = false
  let returns = 0
  let wake: (() => void) | undefined
  const waiting = (): boolean => !queued.length && !ended
  const send = (next: (typeof queued)[number]): void => {
    queued.push(next)
    wake?.()
  }
  const iterator: AsyncIterableIterator<T, undefined> = {
    [Symbol.asyncIterator]: () => iterator,
    next: async () => {
      // eslint-disable-next-line no-await-in-loop -- Waits for the next pushed value.
      while (waiting()) await new Promise<void>((resolve) => (wake = resolve))
      const next = queued.shift()
      if (!next) return { value: undefined, done: true }
      if ("error" in next) throw next.error
      return { value: next.value, done: false }
    },
    return: async () => {
      returns += 1
      return { value: undefined, done: true }
    },
  }
  return {
    iterator,
    push: (value: T) => send({ value }),
    fail: (error: unknown) => send({ error }),
    end: () => {
      ended = true
      wake?.()
    },
    returned: () => returns,
  }
}
