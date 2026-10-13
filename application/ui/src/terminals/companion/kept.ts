// What the companion keeps of something it showed, to show it again at once: the few
// used latest by key, the one used longest ago going first once there are more.
export type Kept<Value> = {
  readonly get: (key: string) => Value | undefined
  readonly keep: (key: string, value: Value) => void
}

export const createKept = <Value>(limit: number): Kept<Value> => {
  const kept = new Map<string, Value>()
  const keep = (key: string, value: Value): void => {
    kept.delete(key)
    kept.set(key, value)
    for (const oldest of kept.keys()) {
      if (kept.size <= limit) break
      kept.delete(oldest)
    }
  }
  return {
    // Using it counts as using it lately.
    get: (key) => {
      if (!kept.has(key)) return undefined
      const value = kept.get(key)!
      keep(key, value)
      return value
    },
    keep,
  }
}
