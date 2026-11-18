// The videos a pane has loaded, as the object URLs that play them, for the last few: a pane
// that goes and comes back plays its video again without reading it. A URL let go of is
// revoked, so its bytes are freed with it, but never while a player holds it: one let go of
// then is revoked once the last player lets go too.

type Urls = {
  readonly create: (blob: Blob) => string
  readonly revoke: (url: string) => void
}

export type Blobs = {
  readonly get: (key: string) => string | undefined
  // Keeps the URL of a blob under `key`, and lets the oldest go beyond the limit.
  readonly keep: (key: string, blob: Blob) => string
  // A player plays `url` until the function it gets back is called.
  readonly hold: (url: string) => () => void
}

export const createBlobs = (
  limit: number,
  urls: Urls = {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
  },
): Blobs => {
  const kept = new Map<string, string>()
  // How many players hold each URL.
  const holds = new Map<string, number>()
  const free = (url: string): void => {
    if (holds.has(url) || [...kept.values()].includes(url)) return
    urls.revoke(url)
  }
  const drop = (key: string): void => {
    const url = kept.get(key)
    if (url === undefined) return
    kept.delete(key)
    free(url)
  }
  return {
    // Using it counts as using it lately.
    get: (key) => {
      const url = kept.get(key)
      if (url === undefined) return undefined
      kept.delete(key)
      kept.set(key, url)
      return url
    },
    keep: (key, blob) => {
      drop(key)
      const url = urls.create(blob)
      kept.set(key, url)
      for (const oldest of kept.keys()) {
        if (kept.size <= limit) break
        drop(oldest)
      }
      return url
    },
    hold: (url) => {
      holds.set(url, (holds.get(url) ?? 0) + 1)
      let held = true
      return () => {
        if (!held) return
        held = false
        const left = (holds.get(url) ?? 1) - 1
        if (left > 0) return void holds.set(url, left)
        holds.delete(url)
        free(url)
      }
    },
  }
}

// One for the app: three videos is a pane or two, and the one just shown.
export const blobs = createBlobs(3)
