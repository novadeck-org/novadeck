import { inboxType, ordered, type InboxItem, type InboxState } from "@novadeck/core/inbox"

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
}

export const initialView: InboxView = { open: null, known: null, order: [], arrived: [] }

const idsOf = (items: readonly InboxItem[]): string[] => items.map(({ id }) => id)

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index])

// The items the list shows, in the Inbox's order, or while a sheet is open in the order it
// opened with. `ghosts` are items the person answered that the backend has since dropped:
// they keep their place, answered, until the sheet closes.
export const visible = (
  view: InboxView,
  items: readonly InboxItem[],
  ghosts: Readonly<Record<string, InboxItem>> = {},
): InboxItem[] =>
  view.open === null || view.known === null
    ? ordered(items)
    : view.order.flatMap((id) => {
        const found = items.find((item) => item.id === id) ?? ghosts[id]
        return found ? [found] : []
      })

// The items waiting to join, oldest first.
export const held = (view: InboxView, items: readonly InboxItem[]): InboxItem[] =>
  view.open === null || view.known === null
    ? []
    : items.filter(({ id }) => !view.known?.includes(id)).toSorted((a, b) => a.at - b.at)

// With no sheet open, the list shows everything: what is new since it last looked is
// marked as arrived. Where a sheet is open the view stays as it is.
export const settle = (view: InboxView, items: readonly InboxItem[]): InboxView => {
  if (view.open !== null) return view
  const ids = idsOf(items)
  const arrived = view.known === null ? [] : ids.filter((id) => !view.known?.includes(id))
  if (view.known !== null && same(view.known, ids) && arrived.length === 0) return view
  return { ...view, known: ids, arrived: arrived.length > 0 ? arrived : view.arrived }
}

// Opens an item's sheet. From a closed Inbox that freezes the list as it stands.
export const openItem = (view: InboxView, id: string, items: readonly InboxItem[]): InboxView => {
  const fresh = view.open === null || view.known === null
  return {
    open: id,
    known: fresh ? idsOf(items) : view.known,
    order: fresh ? idsOf(ordered(items)) : view.order,
    arrived: [],
  }
}

// Closes the sheet: what was held joins the list, marked.
export const closeSheet = (view: InboxView, items: readonly InboxItem[]): InboxView => ({
  open: null,
  known: idsOf(items),
  order: [],
  arrived: held(view, items).map(({ id }) => id),
})

// Lets what is held join the list while the sheet stays open.
export const release = (view: InboxView, items: readonly InboxItem[]): InboxView => ({
  ...view,
  known: idsOf(items),
  order: idsOf(ordered(items)),
  arrived: held(view, items).map(({ id }) => id),
})

export const clearArrived = (view: InboxView): InboxView =>
  view.arrived.length === 0 ? view : { ...view, arrived: [] }

// What the person is asked for next: the most urgent item that is not an update or a feedback
// draft (which asks nothing of them now), other than `from` and those whose answer is on its
// way.
export const nextItem = (
  items: readonly InboxItem[],
  from: string | null,
  state: Pick<InboxState, "answering">,
): InboxItem | undefined =>
  ordered(items).find(
    (item) =>
      item.id !== from &&
      !state.answering[item.id] &&
      inboxType(item) !== "update" &&
      inboxType(item) !== "feedback" &&
      !informing(item),
  )

// The item `step` rows from `from` in the list (1 down, -1 up), within its ends; the
// first when nothing is open.
export const stepFrom = (
  shown: readonly InboxItem[],
  from: string | null,
  step: 1 | -1,
): InboxItem | undefined => {
  const at = shown.findIndex(({ id }) => id === from)
  return shown[Math.max(0, Math.min(shown.length - 1, at + step))]
}

// A stored failed turn that is no longer the agent's current end: it only informs, ranks with
// updates, and is read, not answered.
export const informing = (item: InboxItem): boolean =>
  item.kind === "trouble" &&
  item.trouble.type === "failed" &&
  !!item.trouble.stored &&
  !item.stopped

// What the rail's badge counts: everything that isn't an update, nor a failed turn that only
// informs.
export const needing = (items: readonly InboxItem[]): InboxItem[] =>
  items.filter((item) => inboxType(item) !== "update" && !informing(item))

// What rings the person (a toast, the OS ping): what needs them, except a feedback draft.
// It waits in the Inbox and the badge counts it, but the person asked for it and nothing is
// urgent about it, so it never interrupts.
export const ringing = (items: readonly InboxItem[]): InboxItem[] =>
  needing(items).filter((item) => inboxType(item) !== "feedback")

// Whether Mark all read has anything to read: an update, or a failed turn that only informs.
export const hasUpdates = (items: readonly InboxItem[]): boolean =>
  items.some((item) => inboxType(item) === "update" || informing(item))
