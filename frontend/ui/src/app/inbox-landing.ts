import { noInbox, rowKey, type Inbox, type InboxRow, type InboxState } from "@novadeck/core/inbox"
import { createStore, type Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import { isDesktop, subscribeDesktop } from "../shell/desktop"
import type { Viewing } from "../terminals/unread-state"
import { inboxShown } from "./selectors"
import { viewing, type UiState, type UiStore } from "./ui-store"

// The landing rule: the Inbox the app's list, bell, toasts, OS pings and app badge consume.
// Every row lands at once. Rows for the terminal the person is looking at (see `viewing`: the
// selected terminal while the page has their focus, in every view) land quietly: counted on
// the bell, but with no toast, OS ping or ring, as the person sees them happen there, and
// they stay quiet when the person looks away. A row that landed while they looked elsewhere
// has rung already, and looking at its terminal doesn't take it back. Looking at a terminal
// reads nothing: an update (a done report or a tell) is read in the Inbox's list (see
// `inbox/read-on-leaving.ts`) or by opening it. On a phone, while the Inbox list covers the
// screen, no terminal is looked at.
//
// The marks on a tab and window, and `watchUnreadTurns`, read the raw backend Inbox, never
// this one.
//
// The WorkspaceProvider makes one landing per app (`createServices`) and starts it in an effect,
// so everything that consumes the landed Inbox shares the one object through the workspace
// services.

type WorkspaceSource = Pick<Store<Workspace>, "getSnapshot" | "subscribe">

// The Inbox the app consumes: the raw one's, with the landing rule applied to its state and
// the answer to which rows landed while their terminal was viewed. They count on the bell,
// but the person has already seen them where they happened, so no toast or OS ping rings for
// them.
export type LandedInbox = Inbox & {
  readonly landedQuietly: (row: InboxRow) => boolean
}

// What the shell says of its width: whether the window is wide enough for the sidebar beside
// the terminal, and a way to hear it change.
export type DesktopSource = {
  readonly is: () => boolean
  readonly subscribe: (notify: () => void) => () => void
}

export const pageDesktop: DesktopSource = { is: isDesktop, subscribe: subscribeDesktop }

// The terminal the person looks at: `viewing`, except that on a phone, while the Inbox list
// covers the screen, none is.
export const viewedTerminal = (
  workspace: Workspace,
  ui: UiState,
  desktop: () => boolean = isDesktop,
): Viewing => (inboxShown(ui, desktop) && !desktop() ? null : viewing(workspace, ui))

export type Landing = {
  readonly inbox: LandedInbox
  // Follows the raw Inbox, the workspace and the UI; returns the stop.
  readonly start: () => () => void
}

// The landing of `raw`, following the workspace and the UI store for what the person is
// viewing. Its `inbox` is the one the app consumes: everything but `state` is the raw Inbox's.
// It follows nothing until `start`, which returns the stop and may be called again after it
// (StrictMode starts, stops and starts an effect). Until then it shows the raw rows as the
// rule holds them now. `desktop` says whether the window is wide enough for the sidebar beside the terminal, and
// when that changes: on a phone the Inbox list covers the terminal, which then isn't viewed.
export const landInbox = (
  raw: Inbox,
  workspace: WorkspaceSource,
  ui: Pick<UiStore, "getSnapshot" | "subscribe">,
  desktop: DesktopSource = pageDesktop,
): Landing => {
  // By key, as a newer row under the same id is another (and rings as one): the rows that
  // landed, and those that landed quietly.
  const landed = new Set<string>()
  const quiet = new Set<string>()
  let running = false
  const store = createStore<InboxState>(raw.state.getSnapshot())
  const landedState: Inbox["state"] = {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
  }
  const compute = (): void => {
    const state = raw.state.getSnapshot()
    const looking = viewedTerminal(workspace.getSnapshot(), ui.getSnapshot(), desktop.is)
    const standing = new Set(state.items.map(rowKey))
    for (const set of [landed, quiet])
      for (const key of set) if (!standing.has(key)) set.delete(key)
    for (const row of state.items) {
      const key = rowKey(row)
      const { source } = row
      const here =
        looking !== null &&
        looking.id === source.terminalId &&
        looking.context === `${source.projectId}/${source.workspaceSessionId}`
      // Landing while the person looks at its terminal, it lands quietly, and stays so.
      if (here && !landed.has(key) && !row.settled) quiet.add(key)
      landed.add(key)
    }
    store.update((current) =>
      current.items === state.items &&
      current.answering === state.answering &&
      current.failed === state.failed
        ? current
        : state,
    )
  }
  const sync = (): void => {
    if (running) compute()
  }
  compute()
  return {
    inbox: {
      ...raw,
      state: landedState,
      landedQuietly: (row) => quiet.has(rowKey(row)),
    },
    start: () => {
      running = true
      compute()
      const stops = [
        raw.state.subscribe(sync),
        workspace.subscribe(sync),
        ui.subscribe(sync),
        desktop.subscribe(sync),
      ]
      return () => {
        running = false
        stops.forEach((stop) => stop())
      }
    },
  }
}

// What a backend without an Inbox lands: nothing.
export const noLanding: Landing = {
  inbox: { ...noInbox, landedQuietly: () => false },
  start: () => () => {},
}
