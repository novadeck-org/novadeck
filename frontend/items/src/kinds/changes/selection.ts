import type { ChangeLayer } from "@novadeck/core/items"

// Which layers of a change are looked at, as a slicer works: a selection is always one range
// of rows. Nothing picked means all of them, untouched. The first click picks one row, the
// anchor; the next takes every row between the anchor and the row clicked, either way; a click
// after that starts over from the row clicked. Clicking the anchor alone goes back to all.

/** The layers picked: none, the anchor, or the anchor and the row that ended the range. */
export type Picked = readonly string[]

/** The ids of the layers there are, newest first. */
export const idsOf = (layers: readonly ChangeLayer[]): string[] => layers.map((layer) => layer.id)

/** What the pick means now: the rows from the anchor to its end, or all of them. */
export const selectedOf = (ids: readonly string[], picked: Picked): ReadonlySet<string> => {
  const from = ids.indexOf(picked[0] ?? "")
  if (from < 0) return new Set(ids)
  const to = picked[1] === undefined ? from : ids.indexOf(picked[1])
  if (to < 0) return new Set([ids[from]!])
  return new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1))
}

/** The pick after a click on a layer. */
export const pick = (ids: readonly string[], picked: Picked, id: string): Picked => {
  if (!ids.includes(id)) return picked
  const [anchor, end] = picked
  // A pick whose anchor has gone starts over.
  if (anchor === undefined || !ids.includes(anchor) || end !== undefined) return [id]
  return anchor === id ? [] : [anchor, id]
}

/** Whether only an anchor is picked, which the next click takes a range from. */
export const anchored = (ids: readonly string[], picked: Picked): boolean =>
  picked.length === 1 && ids.includes(picked[0]!)

/** Where a layer's rail starts and ends: not joined to the selected row above or below. */
export type Rail = { readonly on: boolean; readonly start: boolean; readonly end: boolean }

/** The rail of each layer, in order: a selected row joins the selected rows next to it. */
export const railOf = (ids: readonly string[], selected: ReadonlySet<string>): Rail[] =>
  ids.map((id, at) => {
    const on = selected.has(id)
    return {
      on,
      start: on && !selected.has(ids[at - 1] ?? ""),
      end: on && !selected.has(ids[at + 1] ?? ""),
    }
  })

/** What the files below are of: everything, the one layer, or how many of how many. */
export const selectionName = (
  layers: readonly ChangeLayer[],
  selected: ReadonlySet<string>,
): string => {
  if (selected.size === layers.length) return "everything"
  const only = layers.find((layer) => selected.has(layer.id))
  if (selected.size === 1 && only)
    return only.kind === "uncommitted" ? "uncommitted" : only.id.slice(0, 7)
  return `${selected.size} of ${layers.length}`
}
