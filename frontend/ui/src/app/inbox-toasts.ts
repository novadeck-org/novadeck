import type { InboxRow } from "@novadeck/core/inbox"

import { needing } from "../inbox/inbox-state"
import type { ToastBoard } from "../inbox/InboxToasts"
import { isDesktop } from "../shell/desktop"
import { followNeeds, rowKey, needGraceMs, type NeedsInbox } from "./inbox-pings"
import { inboxShown, mayToast, modalOpen } from "./selectors"
import type { UiState, UiStore } from "./ui-store"

// Follows the Inbox and rings toasts on `board` per the rules; returns the stop. It rings
// the rows the OS ping rings (see `followNeeds`), at the same moment and with the opposite
// case: a toast while the page has the person's focus, the ping while it hasn't, so no row
// gets both. A toast shows only if `mayToast` holds as it rings, else the row goes without
// one; while a dialog is open it waits instead, and shows once the dialog closes if its row
// still stands and `mayToast` still holds, unless the person left the app meanwhile, when the
// OS ping takes it (`pings` says one can: the desktop app shows notices); where none can, it stays
// held until the focus returns and the dialog is closed. A newer row of a terminal takes the
// place of its toast, which leaves with its row once that has stayed gone for `graceMs`.
// Toasts already up close when the person gets to what they say (the Inbox opens, or their
// terminal is selected) or a dialog opens.
//
// A restart (the board changing under this) takes the rows now there as seen, so one still
// within its grace doesn't toast. That is acceptable: the Inbox keeps it, and the board only
// restarts as the app mounts.
export const watchInboxToasts = (
  inbox: NeedsInbox,
  ui: UiStore,
  board: ToastBoard,
  {
    graceMs = needGraceMs,
    pings = false,
    ding,
    desktop = isDesktop,
  }: {
    graceMs?: number
    // Whether the OS ping can take a row held when the person leaves the app.
    pings?: boolean
    // Sounds the ding as each toast shows, keyed by its terminal.
    ding?: (terminalId: string) => void
    // Whether the window is wide enough for the resizable sidebar, as the shell asks.
    desktop?: () => boolean
  } = {},
): (() => void) => {
  // The rows held back by a dialog, by terminal: a newer one replaces the older.
  const held = new Map<string, InboxRow>()
  // The toasts this put up that may still show, by terminal.
  const shown = new Map<string, InboxRow>()
  const show = (row: InboxRow): void => {
    shown.set(row.source.terminalId, row)
    ding?.(row.source.terminalId)
    board.show(row)
  }
  const release = (state: UiState): void => {
    // Leaving the app with a row held hands it to the OS ping (see `watchInboxPings`),
    // where there is one; else it waits for the person to come back.
    if (!state.pageFocused && pings) return held.clear()
    if (!state.pageFocused || modalOpen(state) || held.size === 0) return
    const standing = new Set(needing(inbox.state.getSnapshot().items).map(rowKey))
    const rows = [...held.values()]
    held.clear()
    for (const row of rows) if (standing.has(rowKey(row)) && mayToast(state, desktop)) show(row)
  }
  // The person has got to what the toasts say: all of them if the Inbox shows, else the one
  // of the terminal they selected. A modal dialog opening takes them all away too, as one
  // standing over a dialog is out of reach and would time out unseen; their rows stay in the
  // Inbox.
  const arrive = (state: UiState): void => {
    const all = inboxShown(state, desktop) || modalOpen(state)
    const gone = all
      ? [...shown.values()]
      : [shown.get(state.location.route.terminal)].filter((row) => row !== undefined)
    for (const row of gone) {
      shown.delete(row.source.terminalId)
      board.close(row.source.terminalId, row.id)
    }
  }
  const stopFollowing = followNeeds(inbox, {
    graceMs,
    ring: (row) => {
      const state = ui.getSnapshot()
      if (!mayToast(state, desktop)) return false
      // Never over the terminal they're looking at: they came back to it within the grace.
      if (state.location.route.terminal === row.source.terminalId) return false
      if (modalOpen(state)) {
        // Rung all the same, so its leaving is followed: closing a toast never shown is a no-op.
        held.set(row.source.terminalId, row)
        return true
      }
      show(row)
      return true
    },
    leave: (row) => {
      const { terminalId } = row.source
      // Gone for good: it no longer waits behind a dialog, and if it returns it is new.
      if (held.get(terminalId)?.id === row.id) held.delete(terminalId)
      if (shown.get(terminalId)?.id === row.id) shown.delete(terminalId)
      board.close(terminalId, row.id)
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
