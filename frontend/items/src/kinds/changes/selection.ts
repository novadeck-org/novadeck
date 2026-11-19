import type { ChangeLayer } from "@novadeck/core/items"

// Which layers of a change are looked at: all of them, one, or a range. All are to start with; a
// click on a row keeps only that row, a click on another row keeps only that one instead, and a
// click on the row kept alone goes back to all. A Shift+click takes every row from the last row
// clicked (the anchor) to the row Shift+clicked, either way; another Shift+click moves the
// range's end and keeps the anchor.

/** The layers picked: none, which means all of them; the one row kept; or a range's anchor and end. */
export type Picked = readonly string[]

/** The ids of the layers there are, newest first. */
export const idsOf = (layers: readonly ChangeLayer[]): string[] => layers.map((layer) => layer.id)

/** What the pick means now: the rows from the anchor to its end, or all of them where none is (or the anchor has gone). */
export const selectedOf = (ids: readonly string[], picked: Picked): ReadonlySet<string> => {
  const from = ids.indexOf(picked[0] ?? "")
  if (from < 0) return new Set(ids)
  const to = picked[1] === undefined ? from : ids.indexOf(picked[1])
  if (to < 0) return new Set([ids[from]!])
  return new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1))
}

/**
 * The pick after a click on a layer: that row alone, or all where it was kept alone already. A
 * change of one layer keeps none, as that row is all of them: kept, it would hide the layers
 * that come after.
 *
 * With `range` (a Shift+click), the rows from the anchor to it, the anchor kept for the next
 * one; with no anchor yet, it is a click. A range of every row keeps none, as one row of a
 * single layer does.
 */
export const pick = (ids: readonly string[], picked: Picked, id: string, range = false): Picked => {
  if (!ids.includes(id)) return picked
  if (ids.length < 2) return []
  const anchor = picked[0]
  if (range && anchor !== undefined && ids.includes(anchor)) {
    if (anchor === id) return [anchor]
    const span = Math.abs(ids.indexOf(anchor) - ids.indexOf(id)) + 1
    return span === ids.length ? [] : [anchor, id]
  }
  return alone(ids, picked) && anchor === id ? [] : [id]
}

/** Whether one row of several is kept alone, which a click on it again takes back to all. */
export const alone = (ids: readonly string[], picked: Picked): boolean =>
  ids.length > 1 && selectedOf(ids, picked).size === 1

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
  const only = layers.find((layer) => selected.has(layer.id))
  if (selected.size === layers.length || !only) return "everything"
  if (selected.size > 1) return `${selected.size} of ${layers.length}`
  return only.kind === "uncommitted" ? "uncommitted" : only.id.slice(0, 7)
}
