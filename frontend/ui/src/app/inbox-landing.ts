import { noInbox, rowKey, type Inbox, type InboxRow, type InboxState } from "@novadeck/core/inbox"
import { createStore, type Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import { isDesktop, subscribeDesktop } from "../shell/desktop"
import type { Viewing } from "../terminals/unread-state"
import { inboxShown, sameItems } from "./selectors"
import { viewing, type UiState, type UiStore } from "./ui-store"

// The landing rule: the Inbox the app's list, bell, toasts, OS pings and app badge consume.
// Rows for the terminal the person is looking at (see `viewing`: the selected terminal while
// the page has their focus, in every view) don't land while they look: the agent is right
// there, so a row would only repeat it. They land when the person looks away, if still
// unresolved: quietly (no toast or OS ping) once they looked at it for `readDwellMs`, as they
// saw it there, and ringing as any row does after a shorter look. An
// update (a done report or a tell) is read once its terminal has been looked at for a moment
// (`readDwellMs`), whether it landed or not: seeing the terminal is seeing it. A read that
// fails lands the update instead. On a phone, while the Inbox list covers the screen, no
// terminal is looked at. Anything else that landed
// stays: selecting a terminal doesn't take back a row the person must still answer. A row
// the person asks to open by its id (`reveal`) always lands too, as Answer in a terminal's
// Messages does.
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
// the answer to which landed rows arrived while their terminal was viewed and landed later,
// as the person looked away. They count on the bell, but the person has already seen them
// where they happened, so no toast or OS ping rings for them.
export type LandedInbox = Inbox & {
  readonly landedQuietly: (row: InboxRow) => boolean
}

// What the landing rule decides of one raw row, from what is known of it: whether its
// terminal is viewed (`here`), whether it has landed or been kept unread while viewed, whether
// it already landed quietly, and whether it has waited out the dwell (`ripe`).
export type RowFacts = {
  readonly kind: InboxRow["kind"]
  readonly here: boolean
  readonly landed: boolean
  readonly kept: boolean
  readonly quiet: boolean
  readonly ripe: boolean
}

export type RowDecision = {
  // What looking at the row's terminal does to it: `read` an update that has been seen for
  // the dwell, `quiet` a held row seen for the dwell (it lands quietly when it does),
  // `dwell` start or keep waiting for that, or nothing.
  readonly act: "read" | "quiet" | "dwell" | "none"
  // Whether the row is held back from the list for now.
  readonly hold: boolean
}

export const decideRow = ({ kind, here, landed, kept, quiet, ripe }: RowFacts): RowDecision => {
  const held = !landed
  const dwellable = here && !kept && (kind === "update" || (held && !quiet))
  const act = !dwellable ? "none" : !ripe ? "dwell" : kind === "update" ? "read" : "quiet"
  return { act, hold: held && here }
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
  // Lands the raw row `id` now, even while its terminal is viewed or its read is under
  // way; none that is not there, and none before `start`.
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
  // The ids of the rows that landed and of those kept unread while viewed (because the
  // person asked for them or a read failed), which a row keeps through a new `at`; and by
  // key: the updates read by being seen, which never land, the held rows viewed long enough
  // to land quietly, and the reads under way.
  const landed = new Set<string>()
  // The open asks the rule held back, which then settled unseen: they never land.
  const held = new Set<string>()
  const clearing = new Set<string>()
  const kept = new Set<string>()
  const read = new Set<string>()
  const quiet = new Set<string>()
  const reading = new Set<string>()
  // Per row viewed in its terminal that waits on being seen for the dwell, the timer, and
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
    for (const id of landed) if (!ids.has(id)) landed.delete(id)
    for (const id of held) if (!ids.has(id) || landed.has(id)) held.delete(id)
    for (const id of clearing) if (!ids.has(id)) clearing.delete(id)
    for (const id of kept) if (!ids.has(id)) kept.delete(id)
    for (const set of [read, quiet, reading, ripe])
      for (const key of set) if (!standing.has(key)) set.delete(key)
    for (const [key, timer] of dwelling)
      if (!standing.has(key)) {
        clearTimeout(timer)
        dwelling.delete(key)
      }
    const rows: InboxRow[] = []
    const toRead: InboxRow[] = []
    const toClear: string[] = []
    const stillDwelling = new Set<string>()
    for (const row of state.items) {
      const key = rowKey(row)
      const { source } = row
      const here =
        looking !== null &&
        looking.id === source.terminalId &&
        looking.context === `${source.projectId}/${source.workspaceSessionId}`
      if (!here) kept.delete(row.id)
      if (read.has(key)) {
        // A read that failed, or that left the row standing once it settled, mustn't hide
        // it for good: it lands, to be read by hand.
        if (state.failed[row.id] !== undefined || (reading.has(key) && !state.answering[row.id])) {
          read.delete(key)
          reading.delete(key)
          kept.add(row.id)
          landed.add(row.id)
        } else {
          if (state.answering[row.id]) reading.add(key)
          continue
        }
      }
      // A settled row only stays: one held back that settled unseen is dropped, not shown as
      // news, and cleared so it doesn't come back. Any other settled row shows at once.
      if (row.settled) {
        if (held.has(row.id)) {
          if (!clearing.has(row.id)) {
            clearing.add(row.id)
            toClear.push(row.id)
          }
          continue
        }
        landed.add(row.id)
        rows.push(row)
        continue
      }
      const { act, hold } = decideRow({
        kind: row.kind,
        here,
        landed: landed.has(row.id),
        kept: kept.has(row.id),
        quiet: quiet.has(key),
        ripe: ripe.has(key),
      })
      // Looking at its terminal for the dwell reads an update, landed or not, and makes a
      // held row land quietly when it does: the person saw it there.
      if (act === "read" || act === "quiet") ripe.delete(key)
      if (act === "read") {
        read.add(key)
        toRead.push(row)
        continue
      }
      if (act === "quiet") quiet.add(key)
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
      if (hold) {
        held.add(row.id)
        continue
      }
      landed.add(row.id)
      rows.push(row)
    }
    for (const [key, timer] of dwelling)
      if (!stillDwelling.has(key)) {
        clearTimeout(timer)
        dwelling.delete(key)
        ripe.delete(key)
      }
    store.update((current) =>
      sameItems(current.items, rows) &&
      current.answering === state.answering &&
      current.failed === state.failed
        ? current
        : { ...state, items: rows },
    )
    if (running && toClear.length > 0) raw.clear?.(toClear)
    if (running) for (const row of toRead) raw.answer(row.id, { kind: "update", action: "read" })
  }
  const sync = (): void => {
    if (running) compute()
  }
  const reveal = (id: string): void => {
    if (!running) return
    const row = raw.state.getSnapshot().items.find((each) => each.id === id)
    if (!row) return
    // A read in flight gives way: the row shows until the read completes.
    read.delete(rowKey(row))
    reading.delete(rowKey(row))
    landed.add(id)
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
