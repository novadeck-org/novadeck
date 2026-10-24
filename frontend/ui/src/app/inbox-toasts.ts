import type { Inbox, InboxItem } from "@novadeck/core/inbox"

import { needing } from "../inbox/inbox-state"
import type { ToastBoard } from "../inbox/InboxToasts"
import { isDesktop } from "../shell/desktop"
import { sidebarVisible } from "../shell/shell-state"
import { followNeeds, keyOf, needGraceMs } from "./inbox-pings"
import { crashLoopQuestion } from "./selectors"
import type { UiState, UiStore } from "./ui-store"

// Whether the sidebar shows the Inbox's panel.
const inboxShown = (ui: UiState, desktop: boolean): boolean =>
  ui.location.route.panel === "inbox" && sidebarVisible(ui.shell, desktop)

// Whether a modal dialog covers the page, which a toast waits out: Search or Preferences (the
// route's), the close confirmation, the crash-loop question, or the terminal switcher. The
// welcome dialog is the backend's own state, not the UI store's, and the name offer is a chip
// that blocks nothing, so neither holds a toast.
const inDialog = (ui: UiState): boolean =>
  ui.location.route.dialog !== null ||
  ui.closing !== null ||
  crashLoopQuestion(ui) > 0 ||
  ui.recent.switcher !== null

// Whether an item may toast now: the page has the person's focus, they want to hear what
// needs them, the Inbox isn't what they look at, and they aren't typing in the item's own
// terminal (the selected one of the route).
const mayToast = (item: InboxItem, ui: UiState, desktop: boolean): boolean =>
  ui.pageFocused &&
  ui.preferences.notifyNeeds &&
  !inboxShown(ui, desktop) &&
  ui.location.route.terminal !== item.source.terminalId

const desktopNow = (): boolean => {
  try {
    return isDesktop()
  } catch {
    return true
  }
}

// Follows the Inbox and rings toasts on `board` per the rules; returns the stop. It rings
// the items the OS ping rings (see `followNeeds`), at the same moment and with the opposite
// case: a toast while the page has the person's focus, the ping while it hasn't, so no item
// gets both. A toast shows only if `mayToast` holds as it rings, else the item goes without
// one; while a dialog is open it waits instead, and shows once the dialog closes (and the
// page has the person's focus again) if its item still stands and `mayToast` still holds. A
// newer item of a terminal takes the place of its toast, which leaves with its item once that
// has stayed gone for `graceMs`. Toasts already up close when the person gets to what they
// say: the Inbox opens, or their terminal is selected.
//
// A restart (the board changing under this) takes the items now there as seen, so one still
// within its grace doesn't toast. That is acceptable: the Inbox keeps it, and the board only
// restarts as the app mounts.
export const watchInboxToasts = (
  inbox: Pick<Inbox, "state">,
  ui: UiStore,
  board: ToastBoard,
  { graceMs = needGraceMs }: { graceMs?: number } = {},
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
    if (inDialog(state) || !state.pageFocused || held.size === 0) return
    const standing = new Set(needing(inbox.state.getSnapshot().items).map(keyOf))
    const items = [...held.values()]
    held.clear()
    for (const item of items)
      if (standing.has(keyOf(item)) && mayToast(item, state, desktopNow())) show(item)
  }
  // The person has got to what the toasts say: all of them if the Inbox shows, else the one
  // of the terminal they selected.
  const arrive = (state: UiState): void => {
    const gone = inboxShown(state, desktopNow())
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
      if (!mayToast(item, state, desktopNow())) return false
      if (inDialog(state)) {
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
