import { inboxType, ordered, type InboxRow, type InboxState } from "@novadeck/core/inbox"

// Which item the person has open, and what the list shows meanwhile. While a sheet is
// open the list neither reorders nor grows: items that arrive are held, counted by the
// header's pill, and join when the sheet closes, on Next, or when the person asks. Pure,
// so the rules read apart from the components.

export type InboxView = {
  // The item whose sheet is open.
  readonly open: string | null
  // The ids the list may show while a sheet is open: those it showed when it opened. Null
  // until the Inbox has shown its first items, so what it starts with arrives silently.
  readonly known: readonly string[] | null
  // The list's order, as it was when the sheet opened: while one is open nothing moves,
  // however an item's urgency changes. Empty while none is open.
  readonly order: readonly string[]
  // The ids that just joined the list, to be marked for a moment.
  readonly arrived: readonly string[]
  // While the Inbox's panel is on screen: each row that asks, as it last was before it settled,
  // by id. A row that settles meanwhile is placed by that copy, so it keeps its place until the
  // panel is shown again. Empty while the panel is hidden.
  readonly base: Readonly<Record<string, InboxRow>>
}

export const initialView: InboxView = { open: null, known: null, order: [], arrived: [], base: {} }

const idsOf = (items: readonly InboxRow[]): string[] => items.map(({ id }) => id)

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index])

// The Inbox's order, except that a row which settled while the panel was on screen is ranked
// as it was before, so it stays where it was.
const listed = (view: InboxView, items: readonly InboxRow[]): InboxRow[] => {
  if (!items.some((item) => item.settled && view.base[item.id])) return ordered(items)
  const byId = new Map(items.map((item) => [item.id, item]))
  return ordered(items.map((item) => (item.settled && view.base[item.id]) || item)).flatMap(
    ({ id }) => byId.get(id) ?? [],
  )
}

// The items the list shows, in the Inbox's order, or while a sheet is open in the order it
// opened with. `ghosts` are items the person answered that the backend has since dropped:
// they keep their place, answered, until the sheet closes.
export const visible = (
  view: InboxView,
  items: readonly InboxRow[],
  ghosts: Readonly<Record<string, InboxRow>> = {},
): InboxRow[] =>
  view.open === null || view.known === null
    ? listed(view, items)
    : view.order.flatMap((id) => {
        const found = items.find((item) => item.id === id) ?? ghosts[id]
        return found ? [found] : []
      })

// The items waiting to join, oldest first.
export const held = (view: InboxView, items: readonly InboxRow[]): InboxRow[] =>
  view.open === null || view.known === null
    ? []
    : items
        .filter(({ id, settled }) => !settled && !view.known?.includes(id))
        .toSorted((a, b) => a.at - b.at)

// With no sheet open, the list shows everything: what is new since it last looked is
// marked as arrived. Where a sheet is open the view stays as it is.
// `active` says the panel is on screen, whose settled rows then keep their place.
export const settle = (view: InboxView, items: readonly InboxRow[], active = false): InboxView => {
  const base = based(view.base, items, active)
  if (base !== view.base) return settle({ ...view, base }, items, active)
  if (view.open !== null) return view
  const ids = idsOf(items)
  const arrived = view.known === null ? [] : ids.filter((id) => !view.known?.includes(id))
  if (view.known !== null && same(view.known, ids) && arrived.length === 0) return view
  return { ...view, known: ids, arrived: arrived.length > 0 ? arrived : view.arrived }
}

const based = (
  before: InboxView["base"],
  items: readonly InboxRow[],
  active: boolean,
): InboxView["base"] => {
  const next: Record<string, InboxRow> = {}
  if (active)
    for (const item of items) {
      const kept = item.settled ? before[item.id] : item
      if (kept) next[item.id] = kept
    }
  const keys = Object.keys(next)
  return keys.length === Object.keys(before).length && keys.every((id) => before[id] === next[id])
    ? before
    : next
}

// Opens an item's sheet. From a closed Inbox that freezes the list as it stands.
export const openItem = (view: InboxView, id: string, items: readonly InboxRow[]): InboxView => {
  const fresh = view.open === null || view.known === null
  return {
    open: id,
    known: fresh ? idsOf(items) : view.known,
    order: fresh ? idsOf(listed(view, items)) : view.order,
    arrived: [],
    base: view.base,
  }
}

// Closes the sheet: what was held joins the list, marked.
export const closeSheet = (view: InboxView, items: readonly InboxRow[]): InboxView => ({
  open: null,
  known: idsOf(items),
  order: [],
  arrived: held(view, items).map(({ id }) => id),
  base: view.base,
})

// Lets what is held join the list while the sheet stays open.
export const release = (view: InboxView, items: readonly InboxRow[]): InboxView => ({
  ...view,
  known: idsOf(items),
  order: idsOf(listed(view, items)),
  arrived: held(view, items).map(({ id }) => id),
})

export const clearArrived = (view: InboxView): InboxView =>
  view.arrived.length === 0 ? view : { ...view, arrived: [] }

// What the person is asked for next: the most urgent item that is not an update or a feedback
// draft (which asks nothing of them now), other than `from` and those whose answer is on its
// way.
export const nextItem = (
  items: readonly InboxRow[],
  from: string | null,
  state: Pick<InboxState, "answering">,
): InboxRow | undefined =>
  ordered(items).find(
    (item) =>
      item.id !== from &&
      !state.answering[item.id] &&
      !item.settled &&
      inboxType(item) !== "update" &&
      inboxType(item) !== "feedback" &&
      !informing(item),
  )

// The item `step` rows from `from` in the list (1 down, -1 up), within its ends; the
// first when nothing is open.
export const stepFrom = (
  shown: readonly InboxRow[],
  from: string | null,
  step: 1 | -1,
): InboxRow | undefined => {
  const at = shown.findIndex(({ id }) => id === from)
  return shown[Math.max(0, Math.min(shown.length - 1, at + step))]
}

// A stored failed turn that is no longer the agent's current end: it only informs, ranks with
// updates, and is read, not answered.
export const informing = (item: InboxRow): boolean =>
  item.kind === "trouble" &&
  item.trouble.type === "failed" &&
  !!item.trouble.stored &&
  !item.stopped

// Whether an item asks something of the person: anything but an update, a failed turn that
// only informs, or an ask that has settled.
// An ask that has settled asks nothing.
export const needs = (item: InboxRow): boolean =>
  !item.settled && inboxType(item) !== "update" && !informing(item)

// Which row the line above the updates goes on, from whether each row asks, in the list's
// order: the one after the last that asks, or -1 where none asks or nothing follows. Updates
// rank last, but while a sheet is open the order stays as it opened, so a row that has since
// stopped asking keeps its place above the line.
export const updatesStart = (asks: readonly boolean[]): number => {
  const last = asks.lastIndexOf(true)
  return last >= 0 && last < asks.length - 1 ? last + 1 : -1
}

// Which row the line above the settled asks goes on, from whether each row is settled, in the
// list's order: the first of the run of settled rows that ends the list, or -1 where none does
// or nothing precedes them. A row that settles while the panel is on screen keeps its place, so
// it only counts once the rows below it are settled too.
export const settledStart = (settled: readonly boolean[]): number => {
  let start = settled.length
  while (start > 0 && settled[start - 1]) start--
  return start > 0 && start < settled.length ? start : -1
}

// What the rail's badge counts: everything that asks something of the person.
export const needing = (items: readonly InboxRow[]): InboxRow[] => items.filter(needs)

// What rings the person (a toast, the OS ping): what needs them, except a feedback draft.
// It waits in the Inbox and the badge counts it, but the person asked for it and nothing is
// urgent about it, so it never interrupts.
export const ringing = (items: readonly InboxRow[]): InboxRow[] =>
  needing(items).filter((item) => inboxType(item) !== "feedback")

// Whether Mark all read has anything to read: an update, or a failed turn that only informs.
// Whether any ask has settled, for Clear to offer itself.
export const hasSettled = (items: readonly InboxRow[]): boolean =>
  items.some((item) => item.settled)

export const hasUpdates = (items: readonly InboxRow[]): boolean =>
  items.some((item) => inboxType(item) === "update" || informing(item))
