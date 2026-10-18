/**
 * Runs `run` for a key once this tick, however often the key is changed within it, as a
 * burst of changes to one terminal makes one look at it. A run that fails, at once or
 * later, is logged after `label` and stops nothing: the next key still runs.
 */
export const coalesced = (
  run: (key: string) => unknown,
  label: string,
): ((key: string) => void) => {
  const scheduled = new Set<string>()
  const failed = (error: unknown): void => console.error(label, error)
  return (key) => {
    if (scheduled.has(key)) return
    scheduled.add(key)
    setImmediate(() => {
      scheduled.delete(key)
      try {
        const result = run(key)
        if (result instanceof Promise) result.catch(failed)
      } catch (error) {
        failed(error)
      }
    })
  }
}
