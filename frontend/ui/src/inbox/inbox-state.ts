import {
  inboxType,
  ordered,
  rowKey,
  urgency,
  type InboxRow,
  type InboxState,
} from "@novadeck/core/inbox"

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

// The rows that ask, in the order the person dragged them into (`arranged`, their keys): each
// they placed keeps its place among the others they placed, and one that came since goes
// ahead of the first placed row as urgent as it or less, so what is new is seen before what
// they put off. Every other row keeps its place in `list`, the Inbox's order.
export const arrange = (list: readonly InboxRow[], arranged: readonly string[]): InboxRow[] => {
  if (arranged.length === 0) return [...list]
  const rank = new Map(arranged.map((key, index) => [key, index]))
  const placed = (item: InboxRow): boolean => rank.has(rowKey(item))
  const asking = list.filter(asks)
  const result = asking
    .filter(placed)
    .toSorted((a, b) => rank.get(rowKey(a))! - rank.get(rowKey(b))!)
  for (const item of asking) {
    if (placed(item)) continue
    const at = result.findIndex((other) => placed(other) && urgency(other) >= urgency(item))
    result.splice(at < 0 ? result.length : at, 0, item)
  }
  let next = 0
  return list.map((item) => (asks(item) ? result[next++]! : item))
}

// The Inbox's order, the rows that ask as the person arranged them, except that a row which
// settled while the panel was on screen is ranked as it was before, so it stays where it was.
const listed = (
  view: InboxView,
  items: readonly InboxRow[],
  arranged: readonly string[],
): InboxRow[] => {
  if (!items.some((item) => item.settled && view.base[item.id]))
    return arrange(ordered(items), arranged)
  const byId = new Map(items.map((item) => [item.id, item]))
  return arrange(
    ordered(items.map((item) => (item.settled && view.base[item.id]) || item)),
    arranged,
  ).flatMap(({ id }) => byId.get(id) ?? [])
}

// The items the list shows, in the Inbox's order with the rows that ask as the person
// `arranged` them, or while a sheet is open in the order it opened with. `ghosts` are items
// the person answered that the backend has since dropped: they keep their place, answered,
// until the sheet closes.
export const visible = (
  view: InboxView,
  items: readonly InboxRow[],
  ghosts: Readonly<Record<string, InboxRow>> = {},
  arranged: readonly string[] = [],
): InboxRow[] =>
  view.open === null || view.known === null
    ? listed(view, items, arranged)
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
export const openItem = (
  view: InboxView,
  id: string,
  items: readonly InboxRow[],
  arranged: readonly string[] = [],
): InboxView => {
  const fresh = view.open === null || view.known === null
  return {
    open: id,
    known: fresh ? idsOf(items) : view.known,
    order: fresh ? idsOf(listed(view, items, arranged)) : view.order,
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
export const release = (
  view: InboxView,
  items: readonly InboxRow[],
  arranged: readonly string[] = [],
): InboxView => ({
  ...view,
  known: idsOf(items),
  order: idsOf(listed(view, items, arranged)),
  arrived: held(view, items).map(({ id }) => id),
})

// The person's order after a drag, by key: `dragged`, the rows the list showed in their new
// order, with every row of the order `before` that the list didn't show (as one the landing
// rule hides while the person looks at its terminal) kept after the rows it followed,
// wherever the drag put them: one put last stays last. The backend forgets the rows gone.
export const keptOrder = (before: readonly string[], dragged: readonly string[]): string[] => {
  const shown = new Set(dragged)
  const order = [...dragged]
  let after = -1
  for (const id of before) {
    if (shown.has(id)) {
      after = Math.max(after, order.indexOf(id))
      continue
    }
    order.splice(after + 1, 0, id)
    after++
  }
  return order
}

// The rows that ask, `ids`, dragged into this order: while a sheet is open, the list it holds
// still takes it too, each in the places those rows had.
export const rearranged = (view: InboxView, ids: readonly string[]): InboxView => {
  if (view.open === null) return view
  const placed = ids.filter((id) => view.order.includes(id))
  const moved = new Set(placed)
  let next = 0
  const order = view.order.map((id) => (moved.has(id) ? placed[next++]! : id))
  return same(order, view.order) ? view : { ...view, order }
}

export const clearArrived = (view: InboxView): InboxView =>
  view.arrived.length === 0 ? view : { ...view, arrived: [] }

// What the person is asked for next: the first item as they `arranged` them, else the most
// urgent, that is not an update (which asks nothing of them now) nor snoozed, other than
// `from` and those whose answer is on its way.
export const nextItem = (
  items: readonly InboxRow[],
  from: string | null,
  state: Pick<InboxState, "answering">,
  arranged: readonly string[] = [],
): InboxRow | undefined =>
  arrange(ordered(items), arranged).find(
    (item) =>
      item.id !== from &&
      !state.answering[item.id] &&
      !item.settled &&
      !item.snoozed &&
      inboxType(item) !== "update" &&
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
// only informs, or an ask that has settled. A snoozed one still asks: it keeps its place
// among the rest, and drags with them.
export const asks = (item: InboxRow): boolean =>
  !item.settled && inboxType(item) !== "update" && !informing(item)

// Whether an item asks something of the person now: one that asks and isn't snoozed.
export const needs = (item: InboxRow): boolean => asks(item) && !item.snoozed

// Which row the line above the updates goes on, from whether each row asks, in the list's
// order: the one after the last that asks, or -1 where none asks or nothing follows. Updates
// rank last, but while a sheet is open the order stays as it opened, so a row that has since
// stopped asking keeps its place above the line.
export const updatesStart = (asking: readonly boolean[]): number => {
  const last = asking.lastIndexOf(true)
  return last >= 0 && last < asking.length - 1 ? last + 1 : -1
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

// Whether any ask has settled, for Clear to offer itself.
export const hasSettled = (items: readonly InboxRow[]): boolean =>
  items.some((item) => item.settled)

// Whether Mark all read has anything to read: an update, or a failed turn that only informs.
export const hasUpdates = (items: readonly InboxRow[]): boolean =>
  items.some((item) => inboxType(item) === "update" || informing(item))
