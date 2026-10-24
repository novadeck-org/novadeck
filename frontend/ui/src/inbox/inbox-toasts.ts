import type { Inbox, InboxItem } from "@novadeck/core/inbox"

import { followNeeds, keyOf, needGraceMs } from "../app/inbox-pings"
import type { UiState, UiStore } from "../app/ui-store"
import { isDesktop } from "../shell/desktop"
import { needing } from "./inbox-state"

// What shows the Inbox's toasts: one per terminal.
export type ToastBoard = {
  // Shows the item's toast, replacing (in place, moved to the front) any its terminal shows.
  readonly show: (item: InboxItem) => void
  // Takes the terminal's toast away if it still shows that item.
  readonly close: (terminalId: string, itemId: string) => void
}

// Whether the sidebar shows the Inbox's panel, as the app's shell draws it: on a phone the
// open drawer, else the sidebar not collapsed, and never in Zen.
const inboxShown = (ui: UiState, desktop: boolean): boolean =>
  ui.location.route.panel === "inbox" &&
  !ui.shell.zen &&
  (desktop ? !ui.shell.sidebarCollapsed : ui.shell.sidebar)

// The page where the person is in a dialog (Preferences, Search), which a toast waits out.
const inDialog = (ui: UiState): boolean => ui.location.route.dialog !== null

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
// one; while a dialog is open it waits instead, and shows once the dialog closes if its item
// still stands and `mayToast` still holds. A newer item of a terminal takes the place of its
// toast, which leaves with its item once that has stayed gone for `graceMs`.
export const watchInboxToasts = (
  inbox: Pick<Inbox, "state">,
  ui: UiStore,
  board: ToastBoard,
  { graceMs = needGraceMs }: { graceMs?: number } = {},
): (() => void) => {
  // The items held back by a dialog, by terminal: a newer one replaces the older.
  const held = new Map<string, InboxItem>()
  const release = (): void => {
    const state = ui.getSnapshot()
    if (inDialog(state) || held.size === 0) return
    const standing = new Set(needing(inbox.state.getSnapshot().items).map(keyOf))
    const items = [...held.values()]
    held.clear()
    for (const item of items)
      if (standing.has(keyOf(item)) && mayToast(item, state, desktopNow())) board.show(item)
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
      board.show(item)
      return true
    },
    leave: (item) => board.close(item.source.terminalId, item.id),
  })
  const stopHolding = ui.subscribe(release)
  return () => {
    stopFollowing()
    stopHolding()
  }
}
