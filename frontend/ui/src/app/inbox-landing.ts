import { agentWorking } from "@novadeck/core/agents/finish"
import {
  noInbox,
  entryKey,
  type Inbox,
  type InboxEntry,
  type InboxState,
} from "@novadeck/core/inbox"
import { terminalOf } from "@novadeck/core/inbox/history"
import { createStore, type Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import { isDesktop, subscribeDesktop } from "../shell/desktop"
import type { Viewing } from "../terminals/unread-state"
import { inboxShown } from "./selectors"
import { viewing, type UiState, type UiStore } from "./ui-store"

// The landing rule: the Inbox the app's list, bell, toasts, OS pings, app badge and the marks on
// tabs, windows and sessions consume. Every entry lands at once, but for a new ask of the terminal
// the person is looking at (see `viewing`: the selected terminal while the page has their
// focus, in every view). An agent asks first and then writes its question in the terminal, a few
// seconds on, so that ask is held: it shows in the list, but counts nowhere (`heldBack` on its copy
// of the entry) until the first of: the agent's next words show in the terminal (`wordsAt`, after
// the ask), its turn ends, or `holdMs` pass. Then it counts, quietly (see below), as the person
// has read it where it happened. If they look away first it lands then, as an entry that landed
// elsewhere does, and rings once its grace has passed. Only asks are held: not a permission
// request, an update or trouble, and not an ask of another terminal.
//
// Entries for the terminal the person is looking at land quietly: counted on the bell, but with no
// toast, OS ping or ring, as the person sees them happen there, and they stay quiet when the
// person looks away. An entry that landed while they looked elsewhere has rung already, and looking
// at its terminal doesn't take it back. Looking at a terminal reads nothing: an update (a done
// report or a tell) is read in the Inbox's list (see `inbox/read-on-leaving.ts`) or by opening
// it. On a phone, while the Inbox list covers the screen, no terminal is looked at.
//
// The marks on a tab, a window and a session read this Inbox too, so a held ask makes none; and
// `watchUnreadTurns` reads the raw backend Inbox.
//
// The WorkspaceProvider makes one landing per app (`createServices`) and starts it in an effect,
// so everything that consumes the landed Inbox shares the one object through the workspace
// services.

const sameEntries = (a: readonly InboxEntry[], b: readonly InboxEntry[]): boolean =>
  a === b || (a.length === b.length && a.every((entry, index) => entry === b[index]))

type WorkspaceSource = Pick<Store<Workspace>, "getSnapshot" | "subscribe">

// How long a new ask of the terminal the person looks at is held, at the most, waiting for its
// agent's words: the time an agent takes to write the question out. Past it the ask counts, as
// an agent that says nothing is no reason to hide a question.
export const holdMs = 15000

// The Inbox the app consumes: the raw one's, with the landing rule applied to its state and
// the answer to which entries landed while their terminal was viewed. They count on the bell,
// but the person has already seen them where they happened, so no toast or OS ping rings for
// them.
export type LandedInbox = Inbox & {
  readonly landedQuietly: (entry: InboxEntry) => boolean
}

// What the hold on an ask is judged by: whether its entry is an open ask, its terminal viewed
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

// Whether the entry is held: kept out of what counts. It ends at the first of the agent's words,
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
// (StrictMode starts, stops and starts an effect). Until then it shows the raw entries as the
// rule holds them now. `desktop` says whether the window is wide enough for the sidebar beside the terminal, and
// when that changes: on a phone the Inbox list covers the terminal, which then isn't viewed.
export const landInbox = (
  raw: Inbox,
  workspace: WorkspaceSource,
  ui: Pick<UiStore, "getSnapshot" | "subscribe">,
  desktop: DesktopSource = pageDesktop,
): Landing => {
  // By key, as a newer entry under the same id is another (and rings as one): the entries that
  // landed, and those that landed quietly.
  const landed = new Set<string>()
  const quiet = new Set<string>()
  // The asks held, by key, since when (this clock's time) and with the timer that ends the hold.
  const holding = new Map<string, { since: number; timer: ReturnType<typeof setTimeout> | null }>()
  // Each held entry's copy, so it stays the same while the raw entry does.
  const copies = new WeakMap<InboxEntry, InboxEntry>()
  let running = false
  const store = createStore<InboxState>(raw.state.getSnapshot())
  const landedState: Inbox["state"] = {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
  }
  const compute = (): void => {
    const state = raw.state.getSnapshot()
    const looking = viewedTerminal(workspace.getSnapshot(), ui.getSnapshot(), desktop.is)
    const standing = new Set(state.items.map(entryKey))
    for (const set of [landed, quiet])
      for (const key of set) if (!standing.has(key)) set.delete(key)
    for (const [key, hold] of holding)
      if (!standing.has(key)) {
        if (hold.timer !== null) clearTimeout(hold.timer)
        holding.delete(key)
      }
    const now = Date.now()
    const heldKeys = new Set<string>()
    for (const entry of state.items) {
      const key = entryKey(entry)
      const { source } = entry
      const here =
        looking !== null &&
        looking.id === source.terminalId &&
        looking.context === `${source.projectId}/${source.workspaceSessionId}`
      const hold = holding.get(key)
      const terminal =
        entry.kind === "ask" ? terminalOf(workspace.getSnapshot(), source) : undefined
      const isHeld =
        !entry.settled &&
        decideHold({
          ask: entry.kind === "ask",
          here,
          landed: landed.has(key),
          holding: hold !== undefined,
          fresh: now - entry.at <= holdMs,
          // Its turn ended after the ask, though background subagents keep it "working".
          working:
            terminal !== undefined &&
            agentWorking(terminal) &&
            !(terminal.state === "running" && (terminal.agent?.lastTurn?.at ?? 0) > entry.at),
          said:
            terminal?.state === "running" &&
            (terminal.agent?.wordsAt ?? Number.NEGATIVE_INFINITY) > entry.at,
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
      // Landing while the person looks at its terminal, it lands quietly, and stays so. A held
      // ask has not landed: it does when its hold ends, quietly if its terminal is still viewed.
      if (!isHeld) {
        if (here && !landed.has(key) && !entry.settled) quiet.add(key)
        landed.add(key)
      }
    }
    // The entries as the app counts them: the held ones marked, the rest the raw entries.
    const shown =
      heldKeys.size === 0
        ? state.items
        : state.items.map((entry) => {
            if (!heldKeys.has(entryKey(entry))) return entry
            const made = copies.get(entry) ?? { ...entry, heldBack: true as const }
            copies.set(entry, made)
            return made
          })
    store.update((current) =>
      sameEntries(current.items, shown) &&
      current.answering === state.answering &&
      current.failed === state.failed
        ? current
        : { ...state, items: shown },
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
      landedQuietly: (entry) => quiet.has(entryKey(entry)),
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
  start: () => () => {},
}
