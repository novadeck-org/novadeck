// What an app keeps of something it showed, to show it again at once: the few
// used latest by key, the one used longest ago going first once there are more.
export type Kept<Value> = {
  readonly get: (key: string) => Value | undefined
  readonly keep: (key: string, value: Value) => void
}

// Up to `limit` values, or, given `sizeOf`, values up to that much in all.
export const createKept = <Value>(
  limit: number,
  sizeOf: (value: Value) => number = () => 1,
): Kept<Value> => {
  const kept = new Map<string, Value>()
  let size = 0
  const keep = (key: string, value: Value): void => {
    if (kept.has(key)) size -= sizeOf(kept.get(key)!)
    kept.delete(key)
    kept.set(key, value)
    size += sizeOf(value)
    for (const [oldest, each] of kept) {
      if (size <= limit) break
      kept.delete(oldest)
      size -= sizeOf(each)
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
