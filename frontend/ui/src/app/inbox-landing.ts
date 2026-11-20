import { agentWorking } from "@novadeck/core/agents/finish"
import { noInbox, rowKey, type Inbox, type InboxRow, type InboxState } from "@novadeck/core/inbox"
import { terminalOf } from "@novadeck/core/inbox/history"
import { createStore, type Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import { isDesktop, subscribeDesktop } from "../shell/desktop"
import type { Viewing } from "../terminals/unread-state"
import { inboxShown } from "./selectors"
import { viewing, type UiState, type UiStore } from "./ui-store"

// The landing rule: the Inbox the app's list, bell, toasts, OS pings, app badge and the marks on
// tabs, windows and sessions consume. Every row lands at once, but for a new ask of the terminal
// the person is looking at (see `viewing`: the selected terminal while the page has their
// focus, in every view). An agent asks first and then writes its question in the terminal, a few
// seconds on, so that ask is held: it shows in the list, but counts nowhere (`heldBack` on its copy
// of the row) until the first of: the agent's next words show in the terminal (`wordsAt`, after
// the ask), its turn ends, or `holdMs` pass. Then it counts, quietly (see below), as the person
// has read it where it happened. If they look away first it lands then, as a row that landed
// elsewhere does, and rings once its grace has passed. Only asks are held: not a permission
// request, an update or trouble, and not an ask of another terminal.
//
// Rows for the terminal the person is looking at land quietly: counted on the bell, but with no
// toast, OS ping or ring, as the person sees them happen there, and they stay quiet when the
// person looks away. A row that landed while they looked elsewhere has rung already, and looking
// at its terminal doesn't take it back. An update (a done report or a tell) is read once its
// terminal has been looked at for a moment (`readDwellMs`): seeing the terminal is seeing it,
// and it turns resolved, in the history. A glance reads nothing, and a read that fails isn't
// tried again by looking: the update waits to be read by hand. On a phone, while the Inbox list
// covers the screen, no terminal is looked at. A row the person asks to open by its id
// (`reveal`) isn't read by looking either, as Answer in a terminal's Messages opens it.
//
// The marks on a tab, a window and a session read this Inbox too, so a held ask makes none; and
// `watchUnreadTurns` reads the raw backend Inbox.
//
// The WorkspaceProvider makes one landing per app (`createServices`) and starts it in an effect,
// so everything that consumes the landed Inbox, and whatever opens a row by its id, shares
// the one object through the workspace services.

const sameRows = (a: readonly InboxRow[], b: readonly InboxRow[]): boolean =>
  a === b || (a.length === b.length && a.every((row, index) => row === b[index]))

type WorkspaceSource = Pick<Store<Workspace>, "getSnapshot" | "subscribe">

// How long the person must keep looking at a terminal before an update of it counts as seen:
// a glance while passing through doesn't read a report.
export const readDwellMs = 1000

// How long a new ask of the terminal the person looks at is held, at the most, waiting for its
// agent's words: the time an agent takes to write the question out. Past it the ask counts, as
// an agent that says nothing is no reason to hide a question.
export const holdMs = 15000

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

// What the hold on an ask is judged by: whether its row is an open ask, its terminal viewed
// (`here`), it has landed, it is held now (`holding`), it is not older than `holdMs` as it is
// first seen (`fresh`: the Inbox filling in at launch holds nothing), its agent works (`working`)
// and has written words since it asked (`said`), and the hold has run out (`capped`).
export type HoldFacts = {
  readonly ask: boolean
  readonly here: boolean
  readonly landed: boolean
  readonly holding: boolean
  readonly fresh: boolean
  readonly working: boolean
  readonly said: boolean
  readonly capped: boolean
}

// Whether the row is held: kept out of what counts. It ends at the first of the agent's words,
// the end of its turn and the cap, and when the person looks away (which lands it unhushed).
export const decideHold = ({
  ask,
  here,
  landed,
  holding,
  fresh,
  working,
  said,
  capped,
}: HoldFacts): boolean =>
  ask && here && !landed && working && !said && !capped && (holding || fresh)

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
  // The asks held, by key, since when (this clock's time) and with the timer that ends the hold.
  const holding = new Map<string, { since: number; timer: ReturnType<typeof setTimeout> | null }>()
  // Each held row's copy, so it stays the same while the raw row does.
  const copies = new WeakMap<InboxRow, InboxRow>()
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
    for (const [key, hold] of holding)
      if (!standing.has(key)) {
        if (hold.timer !== null) clearTimeout(hold.timer)
        holding.delete(key)
      }
    const now = Date.now()
    const heldKeys = new Set<string>()
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
      const hold = holding.get(key)
      const terminal = row.kind === "ask" ? terminalOf(workspace.getSnapshot(), source) : undefined
      const isHeld =
        !row.settled &&
        decideHold({
          ask: row.kind === "ask",
          here,
          landed: landed.has(key),
          holding: hold !== undefined,
          fresh: now - row.at <= holdMs,
          // Its turn ended after the ask, though background subagents keep it "working".
          working:
            terminal !== undefined &&
            agentWorking(terminal) &&
            !(terminal.state === "running" && (terminal.agent?.lastTurn?.at ?? 0) > row.at),
          said:
            terminal?.state === "running" &&
            (terminal.agent?.wordsAt ?? Number.NEGATIVE_INFINITY) > row.at,
          capped: hold !== undefined && now - hold.since >= holdMs,
        })
      if (isHeld) {
        heldKeys.add(key)
        const since = hold?.since ?? now
        // The cap ends it, though nothing else changes.
        const timer =
          hold?.timer ??
          (running
            ? setTimeout(
                () => {
                  // Spent: forget it, so a compute that finds the cap not reached yet arms another.
                  const own = holding.get(key)
                  if (own) holding.set(key, { since: own.since, timer: null })
                  sync()
                },
                Math.max(0, holdMs - (now - since)),
              )
            : null)
        holding.set(key, { since, timer })
      } else if (hold) {
        if (hold.timer !== null) clearTimeout(hold.timer)
        holding.delete(key)
      }
      const { act, quiet: hushed } = decideRow({
        kind: row.kind,
        here,
        landed: landed.has(key),
        kept: kept.has(row.id),
        read: read.has(key) || Boolean(row.settled),
        ripe: ripe.has(key),
      })
      // Landing while the person looks at its terminal, it lands quietly, and stays so. A held
      // ask has not landed: it does when its hold ends, quietly if its terminal is still viewed.
      if (!isHeld) {
        if (hushed && !row.settled) quiet.add(key)
        landed.add(key)
      }
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
    // The rows as the app counts them: the held ones marked, the rest the raw rows.
    const shown =
      heldKeys.size === 0
        ? state.items
        : state.items.map((row) => {
            if (!heldKeys.has(rowKey(row))) return row
            const made = copies.get(row) ?? { ...row, heldBack: true as const }
            copies.set(row, made)
            return made
          })
    store.update((current) =>
      sameRows(current.items, shown) &&
      current.answering === state.answering &&
      current.failed === state.failed
        ? current
        : { ...state, items: shown },
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
        // A hold's timer goes; the hold stays, and its cap is set again once it starts.
        for (const [key, hold] of holding) {
          if (hold.timer !== null) clearTimeout(hold.timer)
          holding.set(key, { since: hold.since, timer: null })
        }
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
