import type { Placed } from "@novadeck/core/types"

// The recent-terminal switcher: held while Control is down, or opened with a click.
export type RecentSwitcher = {
  readonly context: string
  readonly ids: readonly string[]
  readonly index: number
  // Opened from terminal input, which takes keyboard focus back after switching.
  readonly fromInput: boolean
  readonly mode: "held" | "click"
}

// Terminals most recently selected first, then the rest in sidebar order.
export const nextRecent = (
  previous: readonly string[],
  selected: string,
  ordered: readonly Placed[],
): string[] => [
  ...(selected ? [selected] : []),
  ...previous.filter((id) => id !== selected && ordered.some((terminal) => terminal.id === id)),
  ...ordered
    .map((terminal) => terminal.id)
    .filter((id) => id !== selected && !previous.includes(id)),
]

// The switcher shows only in the session it opened in and never above a dialog.
export const visibleSwitcher = (
  switcher: RecentSwitcher | null,
  context: string,
  dialog: string | null,
): RecentSwitcher | null => (switcher?.context === context && !dialog ? switcher : null)

export const openRecent = (
  context: string,
  ids: readonly string[],
  id: string,
): RecentSwitcher => ({
  context,
  ids,
  index: Math.max(0, ids.indexOf(id)),
  fromInput: false,
  mode: "click",
})

// Moves the highlight one step, wrapping around.
export const moveRecent = (switcher: RecentSwitcher, direction: 1 | -1): RecentSwitcher => ({
  ...switcher,
  index: (switcher.index + direction + switcher.ids.length) % switcher.ids.length,
})

// Ctrl+Tab: opens the held switcher one step from the selection, or keeps cycling the
// one already open. Returns null when there is nothing to switch between.
export const cycleRecent = (
  visible: RecentSwitcher | null,
  start: { context: string; ids: readonly string[]; selected: string; fromInput: boolean },
  direction: 1 | -1,
): RecentSwitcher | null => {
  const ids = visible?.ids ?? start.ids
  if (ids.length < 2) return null
  return {
    context: start.context,
    ids,
    index: ((visible?.index ?? (start.selected ? 0 : -1)) + direction + ids.length) % ids.length,
    fromInput: visible?.fromInput ?? start.fromInput,
    mode: visible?.mode ?? "held",
  }
}

// The switcher without the rows of terminals and windows that left (`here` says which are
// still there), as one an agent closed while it shows: the highlight stays on its row, or,
// where that row went, moves to the row that takes its place, the last where it was the last.
// Null once no row is left; the same switcher where none went.
export const withoutGone = (
  switcher: RecentSwitcher,
  here: (id: string) => boolean,
): RecentSwitcher | null => {
  const ids = switcher.ids.filter(here)
  if (ids.length === switcher.ids.length) return switcher
  if (ids.length === 0) return null
  const highlighted = switcher.ids[switcher.index]
  const kept = highlighted === undefined ? -1 : ids.indexOf(highlighted)
  // Rows before the highlight that went move it up by as many.
  const before = switcher.ids.slice(0, switcher.index).filter(here).length
  return { ...switcher, ids, index: kept >= 0 ? kept : Math.min(before, ids.length - 1) }
}
