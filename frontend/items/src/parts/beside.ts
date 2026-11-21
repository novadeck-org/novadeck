import type { FilePart } from "@novadeck/core/items"

import { loadParts } from "./load"

// A file beside the one shown (a stylesheet or a picture of a page), read whole by its name from
// the shown file's folder, as the backend gives it in parts. It has no size to read to, so parts
// are read until the file ends. `undefined` where it can't be read (missing, outside the
// folder, a kind the backend won't read, a link that dropped) or once `signal` stops it: a page
// draws without a file it can't have.
export const readBeside = async ({
  read,
  signal,
}: {
  readonly read: (offset: number) => Promise<FilePart>
  readonly signal: AbortSignal
}): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  const loaded = await loadParts({
    read,
    size: Number.POSITIVE_INFINITY,
    mime: "application/octet-stream",
    signal,
    progress: () => {},
  })
  return loaded.state === "ready" ? new Uint8Array(await loaded.blob.arrayBuffer()) : undefined
}
