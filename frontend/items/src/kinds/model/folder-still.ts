import type { ModelFormat } from "@novadeck/core/items"

import { loadParts } from "../../parts/load"
import type { EntryThumbRenderer } from "../folder/entry-thumbs"
import { stillBlob } from "./stills"

// A model in a folder's grid: a still of it alone, drawn as its peek's is, by the frame every
// still shares. A model needing files beside it (a glTF's buffers, an OBJ's materials) is drawn
// without them, as the grid reads only the file itself; one that can't be, or is larger than
// `gridBytes`, shows its icon.

const formats: readonly ModelFormat[] = ["glb", "gltf", "stl", "obj", "ply", "3mf"]

/** A model's format, by its file's name; undefined for any other file. */
export const formatOf = (name: string): ModelFormat | undefined => {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
  return formats.find((format) => format === extension)
}

// The largest still the frame draws, square, in pixels.
const largest = 512

// The largest model a grid draws: less than a peek reads, as a grid may ask for many at once, one
// after another through the frame every still shares, within the grid's 15 s for each (its wait
// for its turn in that frame not counted).
export const gridBytes = 8 * 1024 * 1024

export const folderStill: EntryThumbRenderer = async (file, box, signal) => {
  const format = formatOf(file.name)
  // An empty file is one an agent has only begun: its stamp changes as it is written.
  if (!format || file.size === 0 || file.size > gridBytes) return null
  const loaded = await loadParts({
    read: (offset) => file.read(offset, signal),
    size: file.size,
    mime: "application/octet-stream",
    signal,
    progress: () => {},
  })
  if (loaded.state !== "ready" || signal.aborted) return null
  const density = globalThis.devicePixelRatio || 1
  const size = Math.min(largest, Math.ceil(Math.max(box.width, box.height) * density))
  const blob = await stillBlob(
    { format, bytes: loaded.blob, files: [], refused: [] },
    size,
    signal,
    file.queued,
  )
  return blob ? { blob } : null
}
