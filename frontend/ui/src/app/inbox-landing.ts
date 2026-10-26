import { noInbox, type Inbox, type InboxRow, type InboxState } from "@novadeck/core/inbox"
import { createStore, type Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import { isDesktop, subscribeDesktop } from "../shell/desktop"
import type { Viewing } from "../terminals/unread-state"
import { inboxShown } from "./selectors"
import { viewing, type UiState, type UiStore } from "./ui-store"

// The landing rule: the Inbox the app's list, bell, toasts, OS pings and app badge consume.
// Items for the terminal the person is looking at (see `viewing`: the selected terminal while
// the page has their focus, in every view) don't land while they look: the agent is right
// there, so a row would only repeat it. They land when the person looks away, if still
// unresolved: quietly (no toast or OS ping) once they looked at it for `readDwellMs`, as they
// saw it there, and ringing as any item does after a shorter look. An
// update (a done report or a tell) is read once its terminal has been looked at for a moment
// (`readDwellMs`), whether it landed or not: seeing the terminal is seeing it. A read that
// fails lands the update instead. On a phone, while the Inbox list covers the screen, no
// terminal is looked at. Anything else that landed
// stays: selecting a terminal doesn't take back a row the person must still answer. A
// feedback draft the person asked for always lands, and so does an item the person asks to
// open by its id (`reveal`), as Answer in a terminal's Messages does.
//
// The marks on a tab and window, and `watchUnreadTurns`, read the raw backend Inbox, never
// this one.
//
// The WorkspaceProvider makes one landing per app (`createServices`) and starts it in an effect,
// so everything that consumes the landed Inbox, and whatever opens an item by its id, shares
// the one object through the workspace services.

const keyOf = (item: InboxRow): string => `${item.id}@${item.at}`

const sameItems = (a: readonly InboxRow[], b: readonly InboxRow[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index])

type WorkspaceSource = Pick<Store<Workspace>, "getSnapshot" | "subscribe">

// How long the person must keep looking at a terminal before an update of it counts as seen:
// a glance while passing through doesn't read a report.
export const readDwellMs = 1000

// The Inbox the app consumes: the raw one's, with the landing rule applied to its state and
// the answer to which landed items arrived while their terminal was viewed and landed later,
// as the person looked away. They count on the bell, but the person has already seen them
// where they happened, so no toast or OS ping rings for them.
export type LandedInbox = Inbox & {
  readonly landedQuietly: (item: InboxRow) => boolean
}

// What the landing rule decides of one raw item, from what is known of it: whether its
// terminal is viewed (`here`), whether it has landed or been kept unread while viewed, whether
// it already landed quietly, and whether it has waited out the dwell (`ripe`).
export type ItemFacts = {
  readonly kind: InboxRow["kind"]
  readonly here: boolean
  readonly landed: boolean
  readonly kept: boolean
  readonly quiet: boolean
  readonly ripe: boolean
}

export type ItemDecision = {
  // What looking at the item's terminal does to it: `read` an update that has been seen for
  // the dwell, `quiet` a held item seen for the dwell (it lands quietly when it does),
  // `dwell` start or keep waiting for that, or nothing.
  readonly act: "read" | "quiet" | "dwell" | "none"
  // Whether the item is held back from the list for now.
  readonly hold: boolean
}

export const decideItem = ({ kind, here, landed, kept, quiet, ripe }: ItemFacts): ItemDecision => {
  // A feedback draft the person asked for always lands.
  const held = !landed && kind !== "feedback"
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
  // Lands the raw item `id` now, even while its terminal is viewed or its read is under
  // way; none that is not there, and none before `start`.
  readonly reveal: (id: string) => void
  // Follows the raw Inbox, the workspace and the UI; returns the stop.
  readonly start: () => () => void
}

// The landing of `raw`, following the workspace and the UI store for what the person is
// viewing. Its `inbox` is the one the app consumes: everything but `state` is the raw Inbox's.
// It follows nothing until `start`, which returns the stop and may be called again after it
// (StrictMode starts, stops and starts an effect). Until then it shows the raw items as the
// rule holds them now. `desktop` says whether the window is wide enough for the sidebar beside the terminal, and
// when that changes: on a phone the Inbox list covers the terminal, which then isn't viewed.
export const landInbox = (
  raw: Inbox,
  workspace: WorkspaceSource,
  ui: Pick<UiStore, "getSnapshot" | "subscribe">,
  desktop: DesktopSource = pageDesktop,
): Landing => {
  // The ids of the items that landed and of those kept unread while viewed (because the
  // person asked for them or a read failed), which an item keeps through a new `at`; and by
  // key: the updates read by being seen, which never land, the held items viewed long enough
  // to land quietly, and the reads under way.
  const landed = new Set<string>()
  // The open asks the rule held back, which then settled unseen: they never land.
  const held = new Set<string>()
  const kept = new Set<string>()
  const read = new Set<string>()
  const quiet = new Set<string>()
  const reading = new Set<string>()
  // Per item viewed in its terminal that waits on being seen for the dwell, the timer, and
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
    const standing = new Set(state.items.map(keyOf))
    const ids = new Set(state.items.map((item) => item.id))
    for (const id of landed) if (!ids.has(id)) landed.delete(id)
    for (const id of held) if (!ids.has(id) || landed.has(id)) held.delete(id)
    for (const id of kept) if (!ids.has(id)) kept.delete(id)
    for (const set of [read, quiet, reading, ripe])
      for (const key of set) if (!standing.has(key)) set.delete(key)
    for (const [key, timer] of dwelling)
      if (!standing.has(key)) {
        clearTimeout(timer)
        dwelling.delete(key)
      }
    const items: InboxRow[] = []
    const toRead: InboxRow[] = []
    const stillDwelling = new Set<string>()
    for (const item of state.items) {
      const key = keyOf(item)
      const { source } = item
      const here =
        looking !== null &&
        looking.id === source.terminalId &&
        looking.context === `${source.projectId}/${source.workspaceSessionId}`
      if (!here) kept.delete(item.id)
      if (read.has(key)) {
        // A read that failed, or that left the item standing once it settled, mustn't hide
        // it for good: it lands, to be read by hand.
        if (
          state.failed[item.id] !== undefined ||
          (reading.has(key) && !state.answering[item.id])
        ) {
          read.delete(key)
          reading.delete(key)
          kept.add(item.id)
          landed.add(item.id)
        } else {
          if (state.answering[item.id]) reading.add(key)
          continue
        }
      }
      // A settled row only stays: one that never landed is dropped, not shown as news.
      if (item.settled && held.has(item.id)) continue
      const { act, hold } = decideItem({
        kind: item.kind,
        here,
        landed: landed.has(item.id),
        kept: kept.has(item.id),
        quiet: quiet.has(key),
        ripe: ripe.has(key),
      })
      // Looking at its terminal for the dwell reads an update, landed or not, and makes a
      // held item land quietly when it does: the person saw it there.
      if (act === "read" || act === "quiet") ripe.delete(key)
      if (act === "read") {
        read.add(key)
        toRead.push(item)
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
        held.add(item.id)
        continue
      }
      landed.add(item.id)
      items.push(item)
    }
    for (const [key, timer] of dwelling)
      if (!stillDwelling.has(key)) {
        clearTimeout(timer)
        dwelling.delete(key)
        ripe.delete(key)
      }
    store.update((current) =>
      sameItems(current.items, items) &&
      current.answering === state.answering &&
      current.failed === state.failed
        ? current
        : { ...state, items },
    )
    if (running) for (const item of toRead) raw.answer(item.id, { kind: "update", action: "read" })
  }
  const sync = (): void => {
    if (running) compute()
  }
  const reveal = (id: string): void => {
    if (!running) return
    const item = raw.state.getSnapshot().items.find((each) => each.id === id)
    if (!item) return
    // A read in flight gives way: the item shows until the read completes.
    read.delete(keyOf(item))
    reading.delete(keyOf(item))
    landed.add(id)
    kept.add(id)
    sync()
  }
  compute()
  return {
    inbox: {
      ...raw,
      state: landedState,
      landedQuietly: (item) => quiet.has(keyOf(item)),
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
