import {
  inboxType,
  ordered,
  entryKey,
  type InboxEntry,
  type InboxState,
} from "@novadeck/core/inbox"

// Which entry the person has open, and what the list shows meanwhile. While a sheet is
// open the list neither reorders nor grows: entries that arrive are held, counted by the
// header's pill, and join when the sheet closes, on Next, or when the person asks. Pure,
// so the rules read apart from the components.

export type InboxView = {
  // The entry whose sheet is open.
  readonly open: string | null
  // The ids the list may show while a sheet is open: those it showed when it opened. Null
  // until the Inbox has shown its first entries, so what it starts with arrives silently.
  readonly known: readonly string[] | null
  // The list's order, as it was when the sheet opened: while one is open nothing moves,
  // whatever happens to an entry. Empty while none is open.
  readonly order: readonly string[]
  // The entries as they were when the order was taken, by id: while a sheet is open, an entry of the
  // order that the Inbox no longer lists (a resolved one past the ten it lists, or one a newer entry
  // under its id took the place of) stays, as it was, until the sheet closes. Empty while none is
  // open.
  readonly kept: Readonly<Record<string, InboxEntry>>
  // The ids that just joined the list, to be marked for a moment.
  readonly arrived: readonly string[]
  // While the Inbox's panel is on screen: each entry that asks, as it last was before it
  // resolved, by id. An entry that resolves meanwhile is placed by that copy, so it keeps its place
  // until the panel is shown again. Empty while the panel is hidden.
  readonly base: Readonly<Record<string, InboxEntry>>
}

export const initialView: InboxView = {
  open: null,
  known: null,
  order: [],
  kept: {},
  arrived: [],
  base: {},
}

const idsOf = (entries: readonly InboxEntry[]): string[] => entries.map(({ id }) => id)

const entriesById = (entries: readonly InboxEntry[]): Record<string, InboxEntry> =>
  Object.fromEntries(entries.map((entry) => [entry.id, entry]))

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index])

// The open entries, in the order the person dragged them into (`arranged`, their keys): each they
// placed keeps its place among the others they placed, and the entries that came since, the
// newest first, go ahead of them, so what is new is seen before what they put off. Every
// other entry (the resolved ones) keeps its place in `list`, the Inbox's order, and the open entries
// fill the places the open entries had.
export const arrange = (list: readonly InboxEntry[], arranged: readonly string[]): InboxEntry[] => {
  if (arranged.length === 0) return [...list]
  const rank = new Map(arranged.map((key, index) => [key, index]))
  const placed = (entry: InboxEntry): boolean => rank.has(entryKey(entry))
  const asking = list.filter(asks)
  const result = [
    ...asking.filter((entry) => !placed(entry)),
    ...asking.filter(placed).toSorted((a, b) => rank.get(entryKey(a))! - rank.get(entryKey(b))!),
  ]
  let next = 0
  return list.map((entry) => (asks(entry) ? result[next++]! : entry))
}

// The Inbox's order, the open entries as the person arranged them, except that an entry which
// resolved while the panel was on screen is ranked as it was before, so it stays where it was.
const listed = (
  view: InboxView,
  entries: readonly InboxEntry[],
  arranged: readonly string[],
): InboxEntry[] => {
  if (!entries.some((entry) => entry.settled && view.base[entry.id]))
    return arrange(ordered(entries), arranged)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  return arrange(
    ordered(entries.map((entry) => (entry.settled && view.base[entry.id]) || entry)),
    arranged,
  ).flatMap(({ id }) => byId.get(id) ?? [])
}

// The entries the list shows, in the Inbox's order with the open entries as the person
// `arranged` them, or while a sheet is open in the order it opened with. `ghosts` are entries
// the person answered that the backend has since dropped: they keep their place, answered,
// until the sheet closes.
export const visible = (
  view: InboxView,
  entries: readonly InboxEntry[],
  ghosts: Readonly<Record<string, InboxEntry>> = {},
  arranged: readonly string[] = [],
): InboxEntry[] =>
  view.open === null || view.known === null
    ? listed(view, entries, arranged)
    : view.order.flatMap((id) => {
        const was = view.kept[id]
        const now = entries.find((entry) => entry.id === id)
        // Not the entry a newer one has taken the id of.
        const found = now && (!was || now.at === was.at) ? now : (ghosts[id] ?? was)
        return found ? [found] : []
      })

// The entries waiting to join, oldest first.
export const held = (view: InboxView, entries: readonly InboxEntry[]): InboxEntry[] =>
  view.open === null || view.known === null
    ? []
    : entries
        .filter(({ id, settled }) => !settled && !view.known?.includes(id))
        .toSorted((a, b) => a.at - b.at)

// With no sheet open, the list shows everything: what is new since it last looked is
// marked as arrived. Where a sheet is open the view stays as it is.
// `active` says the panel is on screen, whose resolved entries then keep their place.
export const settle = (
  view: InboxView,
  entries: readonly InboxEntry[],
  active = false,
): InboxView => {
  const base = based(view.base, entries, active)
  if (base !== view.base) return settle({ ...view, base }, entries, active)
  if (view.open !== null) return view
  const ids = idsOf(entries)
  // An entry that joins already resolved is history, not news.
  const arrived =
    view.known === null
      ? []
      : entries
          .filter((entry) => !entry.settled && !view.known?.includes(entry.id))
          .map(({ id }) => id)
  if (view.known !== null && same(view.known, ids) && arrived.length === 0) return view
  return { ...view, known: ids, arrived: arrived.length > 0 ? arrived : view.arrived }
}

const based = (
  before: InboxView["base"],
  entries: readonly InboxEntry[],
  active: boolean,
): InboxView["base"] => {
  const next: Record<string, InboxEntry> = {}
  if (active)
    for (const entry of entries) {
      const kept = entry.settled ? before[entry.id] : entry
      if (kept) next[entry.id] = kept
    }
  const keys = Object.keys(next)
  return keys.length === Object.keys(before).length && keys.every((id) => before[id] === next[id])
    ? before
    : next
}

// Opens an entry's sheet. From a closed Inbox that freezes the list as it stands.
export const openEntry = (
  view: InboxView,
  id: string,
  entries: readonly InboxEntry[],
  arranged: readonly string[] = [],
): InboxView => {
  const fresh = view.open === null || view.known === null
  return {
    open: id,
    known: fresh ? idsOf(entries) : view.known,
    order: fresh ? idsOf(listed(view, entries, arranged)) : view.order,
    kept: fresh ? entriesById(entries) : view.kept,
    arrived: [],
    base: view.base,
  }
}

// Closes the sheet: what was held joins the list, marked.
export const closeSheet = (view: InboxView, entries: readonly InboxEntry[]): InboxView => ({
  open: null,
  known: idsOf(entries),
  order: [],
  kept: {},
  arrived: held(view, entries).map(({ id }) => id),
  base: view.base,
})

// Lets what is held join the list while the sheet stays open.
export const release = (
  view: InboxView,
  entries: readonly InboxEntry[],
  arranged: readonly string[] = [],
): InboxView => ({
  ...view,
  known: idsOf(entries),
  order: idsOf(listed(view, entries, arranged)),
  kept: entriesById(entries),
  arrived: held(view, entries).map(({ id }) => id),
})

// The person's order after a drag, by key: `dragged`, the entries the list showed in their new
// order, with every entry of the order `before` that the list didn't show (as one the landing
// rule hides while the person looks at its terminal) kept after the entries it followed,
// wherever the drag put them: one put last stays last. The backend forgets the entries gone.
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

// The entries that ask, `ids`, dragged into this order: while a sheet is open, the list it holds
// still takes it too, each in the places those entries had.
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

// What the person is asked for next: the first entry as they `arranged` them, else the newest,
// that is not an update (which asks nothing of them now) nor snoozed, other than `from` and
// those whose answer is on its way.
export const nextEntry = (
  entries: readonly InboxEntry[],
  from: string | null,
  state: Pick<InboxState, "answering">,
  arranged: readonly string[] = [],
): InboxEntry | undefined =>
  arrange(ordered(entries), arranged).find(
    (entry) =>
      entry.id !== from &&
      !state.answering[entry.id] &&
      !entry.settled &&
      !entry.snoozed &&
      inboxType(entry) !== "update",
  )

// The entry `step` entries from `from` in the list (1 down, -1 up), within its ends; the
// first when nothing is open.
export const stepFrom = (
  shown: readonly InboxEntry[],
  from: string | null,
  step: 1 | -1,
): InboxEntry | undefined => {
  const at = shown.findIndex(({ id }) => id === from)
  return shown[Math.max(0, Math.min(shown.length - 1, at + step))]
}

// Whether an entry asks something of the person: an open entry but an update. A snoozed one still
// asks: it keeps its place among the rest, and drags with them.
export const asks = (entry: InboxEntry): boolean => !entry.settled && inboxType(entry) !== "update"

// Whether an entry asks something of the person now: one that asks and isn't snoozed, nor an ask
// the landing rule still holds back (`heldBack`).
export const needs = (entry: InboxEntry): boolean =>
  asks(entry) && !entry.snoozed && !entry.heldBack

// What the rail's badge counts: everything that asks something of the person.
export const needing = (entries: readonly InboxEntry[]): InboxEntry[] => entries.filter(needs)
