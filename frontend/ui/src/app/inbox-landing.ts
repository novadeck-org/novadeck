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
// has rung already, and looking at its terminal doesn't take it back. An update (a done
// report or a tell) is read once its terminal has been looked at for a moment
// (`readDwellMs`): seeing the terminal is seeing it, and it turns resolved, in the history. A
// glance reads nothing, and a read that fails isn't tried again while they look: the update
// waits to be read by hand. On a phone, while the Inbox list covers the screen, no terminal is
// looked at. A row the person asks to open by its id (`reveal`) isn't read by looking either,
// as Answer in a terminal's Messages opens it.
//
// The marks on a tab and window, and `watchUnreadTurns`, read the raw backend Inbox, never
// this one.
//
// The WorkspaceProvider makes one landing per app (`createServices`) and starts it in an effect,
// so everything that consumes the landed Inbox, and whatever opens a row by its id, shares
// the one object through the workspace services.

type WorkspaceSource = Pick<Store<Workspace>, "getSnapshot" | "subscribe">

// How long the person must keep looking at a terminal before an update of it counts as seen:
// a glance while passing through doesn't read a report.
export const readDwellMs = 1000

// The Inbox the app consumes: the raw one's, with the landing rule applied to its state and
// the answer to which rows landed while their terminal was viewed. They count on the bell,
// but the person has already seen them where they happened, so no toast or OS ping rings for
// them.
export type LandedInbox = Inbox & {
  readonly landedQuietly: (row: InboxRow) => boolean
}

// What the landing rule decides of one raw row, from what is known of it: whether its
// terminal is viewed (`here`), whether it has landed, whether it is kept from being read by
// looking (the person asked for it, or its read failed), whether a read of it is under way
// or done, and whether it has waited out the dwell (`ripe`).
export type RowFacts = {
  readonly kind: InboxRow["kind"]
  readonly here: boolean
  readonly landed: boolean
  readonly kept: boolean
  readonly read: boolean
  readonly ripe: boolean
}

export type RowDecision = {
  // What looking at the row's terminal does to it: `read` an update that has been seen for
  // the dwell, `dwell` start or keep waiting for that, or nothing.
  readonly act: "read" | "dwell" | "none"
  // Whether it lands quietly: it lands now, while its terminal is viewed.
  readonly quiet: boolean
}

export const decideRow = ({ kind, here, landed, kept, read, ripe }: RowFacts): RowDecision => ({
  act: !here || kept || read || kind !== "update" ? "none" : ripe ? "read" : "dwell",
  quiet: here && !landed,
})

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
  // Marks the raw row `id` as the person's to open, so looking at its terminal doesn't read
  // it; none that is not there, and none before `start`.
  readonly reveal: (id: string) => void
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
  // The ids of the rows kept from being read by looking (because the person asked for them or
  // a read failed), which a row keeps through a new `at`; and by key, as a newer row under the
  // same id is another (and rings as one): the rows that landed, those that landed quietly,
  // the updates read by being seen, and the reads under way.
  const kept = new Set<string>()
  const landed = new Set<string>()
  const quiet = new Set<string>()
  const read = new Set<string>()
  const reading = new Set<string>()
  // Per update viewed in its terminal that waits on being seen for the dwell, the timer, and
  // those that have waited it out.
  const dwelling = new Map<string, ReturnType<typeof setTimeout>>()
  const ripe = new Set<string>()
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
    const ids = new Set(state.items.map((row) => row.id))
    for (const id of kept) if (!ids.has(id)) kept.delete(id)
    for (const set of [landed, quiet, read, reading, ripe])
      for (const key of set) if (!standing.has(key)) set.delete(key)
    for (const [key, timer] of dwelling)
      if (!standing.has(key)) {
        clearTimeout(timer)
        dwelling.delete(key)
      }
    const toRead: InboxRow[] = []
    const stillDwelling = new Set<string>()
    for (const row of state.items) {
      const key = rowKey(row)
      const { source } = row
      const here =
        looking !== null &&
        looking.id === source.terminalId &&
        looking.context === `${source.projectId}/${source.workspaceSessionId}`
      // A read that failed, or that left the row standing once it settled, isn't tried again
      // by looking: the update waits to be read by hand.
      if (
        !row.settled &&
        read.has(key) &&
        (state.failed[row.id] !== undefined || (reading.has(key) && !state.answering[row.id]))
      ) {
        read.delete(key)
        reading.delete(key)
        kept.add(row.id)
      } else if (read.has(key) && state.answering[row.id]) reading.add(key)
      const { act, quiet: hushed } = decideRow({
        kind: row.kind,
        here,
        landed: landed.has(key),
        kept: kept.has(row.id),
        read: read.has(key) || Boolean(row.settled),
        ripe: ripe.has(key),
      })
      // Landing while the person looks at its terminal, it lands quietly, and stays so.
      if (hushed && !row.settled) quiet.add(key)
      landed.add(key)
      if (act === "read") {
        ripe.delete(key)
        read.add(key)
        toRead.push(row)
      }
      if (act === "dwell") {
        stillDwelling.add(key)
        if (running && !dwelling.has(key))
          dwelling.set(
            key,
            setTimeout(() => {
              dwelling.delete(key)
              ripe.add(key)
              sync()
            }, readDwellMs),
          )
      }
    }
    for (const [key, timer] of dwelling)
      if (!stillDwelling.has(key)) {
        clearTimeout(timer)
        dwelling.delete(key)
        ripe.delete(key)
      }
    store.update((current) =>
      current.items === state.items &&
      current.answering === state.answering &&
      current.failed === state.failed
        ? current
        : state,
    )
    if (running) for (const row of toRead) raw.answer(row.id, { kind: "update", action: "read" })
  }
  const sync = (): void => {
    if (running) compute()
  }
  const reveal = (id: string): void => {
    if (!running) return
    if (!raw.state.getSnapshot().items.some((each) => each.id === id)) return
    // Opened by the person, it is theirs to read: looking doesn't read it as well.
    kept.add(id)
    sync()
  }
  compute()
  return {
    inbox: {
      ...raw,
      state: landedState,
      landedQuietly: (row) => quiet.has(rowKey(row)),
    },
    reveal,
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
        dwelling.forEach(clearTimeout)
        dwelling.clear()
      }
    },
  }
}

// What a backend without an Inbox lands: nothing.
export const noLanding: Landing = {
  inbox: { ...noInbox, landedQuietly: () => false },
  reveal: () => {},
  start: () => () => {},
}
