import type { ChangeLayer } from "@novadeck/core/items"

// Which layers of a change are looked at: all of them, or one. All are to start with; a click on
// a row keeps only that row, a click on another row keeps only that one instead, and a click on
// the row kept alone goes back to all.

/** The layers picked: none, which means all of them, or the one row kept. */
export type Picked = readonly string[]

/** The ids of the layers there are, newest first. */
export const idsOf = (layers: readonly ChangeLayer[]): string[] => layers.map((layer) => layer.id)

/** What the pick means now: the row kept, or all of them where none is (or it has gone). */
export const selectedOf = (ids: readonly string[], picked: Picked): ReadonlySet<string> => {
  const only = picked[0]
  return only !== undefined && ids.includes(only) ? new Set([only]) : new Set(ids)
}

/** The pick after a click on a layer: that row alone, or all where it was kept alone already. */
export const pick = (ids: readonly string[], picked: Picked, id: string): Picked => {
  if (!ids.includes(id)) return picked
  return alone(ids, picked) && picked[0] === id ? [] : [id]
}

/** Whether one row is kept alone, which a click on it again takes back to all. */
export const alone = (ids: readonly string[], picked: Picked): boolean =>
  picked[0] !== undefined && ids.includes(picked[0])

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
