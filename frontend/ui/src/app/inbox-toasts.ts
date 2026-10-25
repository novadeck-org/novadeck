import type { Inbox, InboxItem } from "@novadeck/core/inbox"

import { ringing } from "../inbox/inbox-state"
import type { ToastBoard } from "../inbox/InboxToasts"
import { isDesktop } from "../shell/desktop"
import { followNeeds, keyOf, needGraceMs } from "./inbox-pings"
import { inboxShown, mayToast, modalOpen } from "./selectors"
import type { UiState, UiStore } from "./ui-store"

// Follows the Inbox and rings toasts on `board` per the rules; returns the stop. It rings
// the items the OS ping rings (see `followNeeds`), at the same moment and with the opposite
// case: a toast while the page has the person's focus, the ping while it hasn't, so no item
// gets both. A toast shows only if `mayToast` holds as it rings, else the item goes without
// one; while a dialog is open it waits instead, and shows once the dialog closes if its item
// still stands and `mayToast` still holds, unless the person left the app meanwhile, when the
// OS ping takes it (`pings` says one can: the host shows notices); where none can, it stays
// held until the focus returns and the dialog is closed. A newer item of a terminal takes the
// place of its toast, which leaves with its item once that has stayed gone for `graceMs`.
// Toasts already up close when the person gets to what they say (the Inbox opens, or their
// terminal is selected) or a dialog opens.
//
// A restart (the board changing under this) takes the items now there as seen, so one still
// within its grace doesn't toast. That is acceptable: the Inbox keeps it, and the board only
// restarts as the app mounts.
export const watchInboxToasts = (
  inbox: Pick<Inbox, "state">,
  ui: UiStore,
  board: ToastBoard,
  {
    graceMs = needGraceMs,
    pings = false,
    desktop = isDesktop,
  }: {
    graceMs?: number
    // Whether the OS ping can take an item held when the person leaves the app.
    pings?: boolean
    // Whether the window is wide enough for the resizable sidebar, as the shell asks.
    desktop?: () => boolean
  } = {},
): (() => void) => {
  // The items held back by a dialog, by terminal: a newer one replaces the older.
  const held = new Map<string, InboxItem>()
  // The toasts this put up that may still show, by terminal.
  const shown = new Map<string, InboxItem>()
  const show = (item: InboxItem): void => {
    shown.set(item.source.terminalId, item)
    board.show(item)
  }
  const release = (state: UiState): void => {
    // Leaving the app with an item held hands it to the OS ping (see `watchInboxPings`),
    // where there is one; else it waits for the person to come back.
    if (!state.pageFocused && pings) return held.clear()
    if (!state.pageFocused || modalOpen(state) || held.size === 0) return
    const standing = new Set(ringing(inbox.state.getSnapshot().items).map(keyOf))
    const items = [...held.values()]
    held.clear()
    for (const item of items) if (standing.has(keyOf(item)) && mayToast(state, desktop)) show(item)
  }
  // The person has got to what the toasts say: all of them if the Inbox shows, else the one
  // of the terminal they selected. A modal dialog opening takes them all away too, as one
  // standing over a dialog is out of reach and would time out unseen; their items stay in the
  // Inbox.
  const arrive = (state: UiState): void => {
    const all = inboxShown(state, desktop) || modalOpen(state)
    const gone = all
      ? [...shown.values()]
      : [shown.get(state.location.route.terminal)].filter((item) => item !== undefined)
    for (const item of gone) {
      shown.delete(item.source.terminalId)
      board.close(item.source.terminalId, item.id)
    }
  }
  const stopFollowing = followNeeds(inbox, {
    graceMs,
    ring: (item) => {
      const state = ui.getSnapshot()
      if (!mayToast(state, desktop)) return false
      // Never over the terminal they're looking at: they came back to it within the grace.
      if (state.location.route.terminal === item.source.terminalId) return false
      if (modalOpen(state)) {
        // Rung all the same, so its leaving is followed: closing a toast never shown is a no-op.
        held.set(item.source.terminalId, item)
        return true
      }
      show(item)
      return true
    },
    leave: (item) => {
      const { terminalId } = item.source
      // Gone for good: it no longer waits behind a dialog, and if it returns it is new.
      if (held.get(terminalId)?.id === item.id) held.delete(terminalId)
      if (shown.get(terminalId)?.id === item.id) shown.delete(terminalId)
      board.close(terminalId, item.id)
    },
  })
  const stopHolding = ui.subscribe(() => {
    const state = ui.getSnapshot()
    arrive(state)
    release(state)
  })
  return () => {
    stopFollowing()
    stopHolding()
  }
}
