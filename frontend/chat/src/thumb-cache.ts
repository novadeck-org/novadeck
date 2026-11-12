import type { ChatImage } from "@novadeck/core/conversation"

// The pictures of recorded prompts the chat has asked for, so scrolling away from a thumbnail and
// back, or a window that draws it again, doesn't ask the backend twice. A picture is a data URL of
// up to 8 MiB, so only the latest `limit` stay (each thumbnail on screen holds its own picture
// besides, as an image element does: a window of many large screenshots costs their sum). A
// picture the backend has none of (swept, moved, refused) is kept as none; one it could not be
// asked for is not kept, but its failure is remembered for `backoffMs`, so asking again within it
// fails at once, as the first did, instead of asking the backend each time a row is drawn.
export type ThumbCache = {
  // What was found for the image, if it was asked for: its data URL, null for none, or undefined.
  readonly peek: (item: string, image: ChatImage) => string | null | undefined
  // The picture, asked for once however many ask while it is on its way.
  readonly load: (
    item: string,
    image: ChatImage,
    fetch: (image: ChatImage) => Promise<string | null>,
  ) => Promise<string | null>
}

const keyOf = (item: string, { offset, index }: ChatImage): string => `${item}\n${offset}:${index}`

export const backoffMs = 15_000

export const createThumbCache = (
  limit = 24,
  wait = backoffMs,
  now: () => number = Date.now,
): ThumbCache => {
  const found = new Map<string, string | null>()
  const asked = new Map<string, Promise<string | null>>()
  const failed = new Map<string, { readonly at: number; readonly error: unknown }>()
  return {
    peek: (item, image) => {
      const key = keyOf(item, image)
      if (!found.has(key)) return undefined
      // Seen lately: the longest unseen goes first.
      const picture = found.get(key)!
      found.delete(key)
      found.set(key, picture)
      return picture
    },
    load: (item, image, fetch) => {
      const key = keyOf(item, image)
      if (found.has(key)) return Promise.resolve(found.get(key)!)
      const failure = failed.get(key)
      if (failure && now() - failure.at < wait) return Promise.reject(failure.error)
      failed.delete(key)
      const pending =
        asked.get(key) ??
        fetch(image)
          .then((picture) => {
            found.set(key, picture)
            for (const [oldest] of found) {
              if (found.size <= limit) break
              found.delete(oldest)
            }
            return picture
          })
          .catch((error: unknown) => {
            failed.set(key, { at: now(), error })
            throw error
          })
          .finally(() => asked.delete(key))
      asked.set(key, pending)
      return pending
    },
  }
}
