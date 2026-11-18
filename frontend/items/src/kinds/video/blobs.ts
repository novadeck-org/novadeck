// The videos a pane has loaded, as the object URLs that play them, for the last few: a pane
// that goes and comes back plays its video again without reading it. Each item keeps its
// latest file only: a render that follows lets the one before go. A URL let go of is revoked,
// so its bytes are freed with it, but never while a player holds it: one let go of then is
// revoked once the last player lets go too.

type Urls = {
  readonly create: (blob: Blob) => string
  readonly revoke: (url: string) => void
}

export type Blobs = {
  // The URL of the item's file as `stamp` names it, while it is kept.
  readonly get: (item: string, stamp: string) => string | undefined
  // Keeps the URL of the item's file as `stamp` names it, in place of any other of the item's,
  // and lets the oldest go beyond the limit.
  readonly keep: (item: string, stamp: string, blob: Blob) => string
  // The item's file kept now, whichever stamp it is at: what a pane that comes back plays
  // while it reads a newer one.
  readonly latest: (item: string) => { readonly stamp: string; readonly url: string } | undefined
  // The bytes `url` plays, while it is kept: a page can't fetch its own blob URL under the
  // app's content security policy, so what reads the bytes (as a waveform's peaks) asks here.
  readonly bytes: (url: string) => Blob | undefined
  // A player plays `url` until the function it gets back is called.
  readonly hold: (url: string) => () => void
}

type Kept = {
  readonly item: string
  readonly stamp: string
  readonly url: string
  readonly blob: Blob
}

export const createBlobs = (
  limit: number,
  urls: Urls = {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
  },
): Blobs => {
  // By item, the oldest used first.
  const kept = new Map<string, Kept>()
  // How many players hold each URL.
  const holds = new Map<string, number>()
  const free = (url: string): void => {
    if (holds.has(url) || [...kept.values()].some((each) => each.url === url)) return
    urls.revoke(url)
  }
  const release = (item: string): void => {
    const was = kept.get(item)
    if (!was) return
    kept.delete(item)
    free(was.url)
  }
  return {
    // Using it counts as using it lately.
    get: (item, stamp) => {
      const was = kept.get(item)
      if (was?.stamp !== stamp) return undefined
      kept.delete(item)
      kept.set(item, was)
      return was.url
    },
    keep: (item, stamp, blob) => {
      release(item)
      const url = urls.create(blob)
      kept.set(item, { item, stamp, url, blob })
      for (const oldest of kept.keys()) {
        if (kept.size <= limit) break
        release(oldest)
      }
      return url
    },
    bytes: (url) => [...kept.values()].find((each) => each.url === url)?.blob,
    latest: (item) => {
      const was = kept.get(item)
      return was && { stamp: was.stamp, url: was.url }
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
