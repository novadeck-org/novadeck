import type { VideoPart } from "@novadeck/core/items"

// A video's bytes, read in parts and put together, which the player plays from a blob. The
// read is the backend's (`Companions.videoPart`, bound to the item and the stamp it was
// loaded for); this only walks the file.

export type Loaded =
  // The whole file, as a blob of its format.
  | { readonly state: "ready"; readonly blob: Blob }
  // The file was rewritten while it was read: what was read is dropped, and the item's new
  // content, which follows, has a stamp of its own to read from.
  | { readonly state: "changed" }
  | {
      readonly state: "unavailable"
      readonly reason: Extract<VideoPart, { state: "unavailable" }>["reason"]
    }
  // The backend failed the read, as a link that dropped.
  | { readonly state: "failed" }
  // Whoever asked stopped waiting.
  | { readonly state: "stopped" }

// Reads from offset 0 until `size` bytes are in, or the file ends sooner (a part with no
// bytes), telling the bytes read so far after each part.
export const loadVideo = async ({
  read,
  size,
  mime,
  signal,
  progress,
}: {
  readonly read: (offset: number) => Promise<VideoPart>
  readonly size: number
  readonly mime: string
  readonly signal: AbortSignal
  readonly progress: (bytes: number) => void
}): Promise<Loaded> => {
  const parts: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  while (offset < size) {
    let part: VideoPart
    try {
      // eslint-disable-next-line no-await-in-loop -- Each part is read from where the last ended.
      part = await read(offset)
    } catch {
      return signal.aborted ? { state: "stopped" } : { state: "failed" }
    }
    if (signal.aborted) return { state: "stopped" }
    if (part.state === "changed") return part
    if (part.state === "unavailable") return part
    if (part.bytes.length === 0) break
    parts.push(part.bytes)
    offset += part.bytes.length
    progress(offset)
  }
  return { state: "ready", blob: new Blob(parts, { type: mime }) }
}
