import { modelStills, type ModelContent, type ModelStills } from "@novadeck/viewers/model"

import { modelFrame } from "./assets"

// Stills of models, for their peeks and a folder's grid, drawn by one frame out of sight that
// every still shares (see @novadeck/viewers/model's `modelStills`), and kept by model and size
// as images' addresses, the latest 64.
let stills: ModelStills | undefined
const made = new Map<string, Promise<string | null>>()
const keep = 64

/** The most a peek reads of a model, its files with it, to draw a still: past it, a badge. */
export const peekBytes = 32 * 1024 * 1024

/** A still's address, if one was made for `key` (a model's item and stamp) at `size`. */
export const madeStill = (key: string, size: number): Promise<string | null> | undefined =>
  made.get(`${key}@${size}`)

// The frame that draws them; one let go of is made afresh.
const frame = (): ModelStills => {
  if (stills?.stopped()) {
    stills.destroy()
    stills = undefined
  }
  stills ??= modelStills(document, modelFrame())
  return stills
}

/**
 * A still of a model, `size` pixels square, as a PNG, or null where none is drawn; for a folder's
 * grid, which keeps it by the file's stamp. It stops once `signal` aborts, and calls `queued` as
 * it starts waiting its turn behind other stills, and what that gives back once its turn comes.
 */
export const stillBlob = (
  model: ModelContent,
  size: number,
  signal: AbortSignal,
  queued?: () => () => void,
): Promise<Blob | null> =>
  frame()
    .still(model, size, signal, queued)
    .catch(() => null)

/**
 * A still of a model, `size` pixels square, as an image's address; null where none is drawn,
 * which isn't kept, so the next peek asks again.
 */
export const stillOf = (key: string, model: ModelContent, size: number): Promise<string | null> => {
  const at = `${key}@${size}`
  const known = made.get(at)
  if (known) return known
  const still = frame()
    .still(model, size)
    .then((blob) => (blob ? URL.createObjectURL(blob) : null))
    .catch(() => null)
    .then((url) => {
      if (url === null) made.delete(at)
      return url
    })
  made.set(at, still)
  // The oldest let go of, its address with it.
  for (const [old, url] of made) {
    if (made.size <= keep) break
    made.delete(old)
    void url.then((address) => address && URL.revokeObjectURL(address))
  }
  return still
}
