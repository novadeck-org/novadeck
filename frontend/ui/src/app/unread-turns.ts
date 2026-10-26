import { doneNotice, finishNotice } from "@novadeck/core/agent-finish"
import { terminalDone, type Inbox, type InboxRow, type InboxTurn } from "@novadeck/core/inbox"
import { leadHearsOf } from "@novadeck/core/inbox-rows"
import type { Store } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"

import { isDesktop } from "../shell/desktop"
import { sameUnread, turnContext, unreadEnd, unreadOfTurns } from "../terminals/unread-state"
import { viewedTerminal } from "./inbox-landing"
import type { UiStore } from "./ui-store"

// How long before this started a row may have ended and still be new: the same slack as the
// Inbox pings'.
const launchSlackMs = 5000

// A desktop notification about one terminal, as a backend shows it.
// `itemId` is the Inbox row it is about, which a click on it opens.
export type FinishNotify = (
  notice: { readonly id: string; readonly title: string; readonly body: string },
  itemId: string,
) => void

// Every terminal of every session, by `${context}/${terminalId}`.
type Terminals = ReadonlyMap<string, TerminalMetadata>
const terminalsOf = (workspace: Workspace): Terminals =>
  new Map(
    workspace.projects.flatMap((project) =>
      project.history.flatMap((session) =>
        session.state.roster.terminals.map(
          (terminal) => [`${project.id}/${session.id}/${terminal.id}`, terminal] as const,
        ),
      ),
    ),
  )

const terminalOf = (terminals: Terminals, turn: InboxTurn): TerminalMetadata | undefined =>
  terminals.get(`${turnContext(turn)}/${turn.terminalId}`)

// A terminal's unseen `done` report, as the Inbox lists it.
type DoneEntry = Extract<InboxRow, { kind: "update" }>
const doneEntries = (items: readonly InboxRow[]): DoneEntry[] =>
  items.filter(
    (item): item is DoneEntry =>
      item.kind === "update" && item.update.type === "done" && !item.seen,
  )

const entryContext = (item: InboxRow): string =>
  `${item.source.projectId}/${item.source.workspaceSessionId}`

// Follows the stored finished turns of the Inbox (`inbox.turns`) and its done reports
// (`inbox.state`) for the rest of the app.
//
// The terminals' unread marks (`ui.unread`) mirror the turns: each terminal with unread rows
// carries how its newest row ended (`unread` or `failed`). A completed row of a worker whose
// lead's agent runs is the lead's to hear, so it marks nothing, as the Inbox hides it too;
// its failed row still marks. The marks outlast the agent's next turn, as the rows do. A done
// report is no turn: the tab reads it from the Inbox's items itself.
//
// Looking reads: the rows of the terminal the person views (the selected one while the page
// has their focus, but on a phone not while the Inbox list covers the screen), as they come in and, on a focused launch, as they were stored.
//
// What is new tells `notify`, where given, once, only while the page hasn't their focus and
// not for a worker whose lead's agent runs, as that lead hears of it: a done report, where
// the person wants to hear of finishes, and a failed row, where they don't already hear of
// it as trouble. A bare completed turn tells nothing, as it isn't a finish. A terminal has
// one notification, the newest replacing the last, and `clear` takes it back once the
// terminal has no unseen done report nor failed row. A row or report is new if no listing
// held it before and it did not end before this started; the first listing, and the first
// after the backend lost its rows, only takes in what it holds.
export const watchUnreadTurns = (
  inbox: Pick<Inbox, "turns" | "readFinishes" | "state">,
  workspace: Store<Workspace>,
  ui: UiStore,
  {
    notify,
    clear,
    desktop = isDesktop,
  }: {
    notify?: FinishNotify | undefined
    clear?: ((terminalId: string) => void) | undefined
    // Whether the window is wide enough for the sidebar beside the terminal.
    desktop?: () => boolean
  } = {},
): (() => void) => {
  const { turns, readFinishes, state: items } = inbox
  if (!turns) return () => {}
  const startedAt = Date.now()
  // Every row id any listing held since the last baseline.
  let listed: Set<string> | undefined
  // Every done report id the same listings held.
  let listedDone: Set<string> | undefined
  // The rows asked to be read, while listed.
  let asked = new Set<string>()
  // The terminals whose notification stands, by id, with their session context and what it is
  // about.
  const notified = new Map<string, { context: string; kind: "done" | "failed" }>()
  let running = false
  let again = false

  const run = (): void => {
    const list = turns.getSnapshot()
    const snapshot = workspace.getSnapshot()
    const state = ui.getSnapshot()
    if (list === undefined) {
      listed = undefined
      listedDone = undefined
      asked = new Set()
      mirror([])
      sweep([], [])
      return
    }
    const looking = viewedTerminal(snapshot, state, desktop)
    const viewed = (turn: InboxTurn): boolean =>
      looking?.context === turnContext(turn) && looking.id === turn.terminalId
    const before = listed
    const fresh = before ? list.filter((turn) => !before.has(turn.id)) : []
    listed = new Set([...(before ?? []), ...list.map((turn) => turn.id)])
    const terminals = terminalsOf(snapshot)
    const entries = doneEntries(items.getSnapshot().items)
    const beforeDone = listedDone
    const freshDone = beforeDone ? entries.filter((entry) => !beforeDone.has(entry.id)) : []
    listedDone = new Set([...(beforeDone ?? []), ...entries.map((entry) => entry.id)])
    // A completed row of a worker whose lead's agent runs is the lead's, as in the Inbox.
    const heard = (turn: InboxTurn): boolean =>
      turn.outcome === "completed" && leadHearsOf(snapshot, turnContext(turn), turn.terminalId)
    const unviewed = list.filter((turn) => !viewed(turn))
    mirror(unviewed.filter((turn) => !heard(turn)))
    announce(
      fresh.filter((turn) => turn.at >= startedAt - launchSlackMs && !viewed(turn)),
      snapshot,
      terminals,
    )
    announceDone(
      freshDone.filter(
        (entry) =>
          entry.at >= startedAt - launchSlackMs &&
          !(looking?.context === entryContext(entry) && looking.id === entry.source.terminalId),
      ),
      snapshot,
      terminals,
    )
    sweep(
      unviewed.filter((turn) => !heard(turn)),
      entries.filter(
        (entry) =>
          !(looking?.context === entryContext(entry) && looking.id === entry.source.terminalId),
      ),
    )
    asked = new Set([...asked].filter((id) => list.some((turn) => turn.id === id)))
    const reading = list.filter((turn) => viewed(turn) && !asked.has(turn.id))
    if (reading.length === 0 || !readFinishes || !looking) return
    reading.forEach((turn) => asked.add(turn.id))
    readFinishes([{ context: looking.context, terminalId: looking.id }])
  }

  const mirror = (rows: readonly InboxTurn[]): void => {
    const unread = unreadOfTurns(rows)
    ui.update((current) => (sameUnread(current.unread, unread) ? current : { ...current, unread }))
  }

  const announce = (
    rows: readonly InboxTurn[],
    snapshot: Workspace,
    terminals: Terminals,
  ): void => {
    const { pageFocused, preferences } = ui.getSnapshot()
    if (!notify || !preferences.notifyFinished || pageFocused) return
    const newest = new Map<string, InboxTurn>()
    for (const turn of rows) {
      if (turn.outcome !== "failed") continue
      const key = `${turnContext(turn)}/${turn.terminalId}`
      const known = newest.get(key)
      if (!known || turn.at >= known.at) newest.set(key, turn)
    }
    for (const turn of newest.values()) {
      const terminal = terminalOf(terminals, turn)
      if (!terminal || leadHearsOf(snapshot, turnContext(turn), turn.terminalId)) continue
      // A failed turn is trouble in the Inbox, which pings of its own where the person wants
      // what needs them: one notification for it, not two.
      if (preferences.notifyNeeds) continue
      notify(
        {
          id: terminal.id,
          ...finishNotice(
            terminal,
            turn.reply === null ? { failed: true } : { failed: true, reply: turn.reply },
          ),
        },
        turn.id,
      )
      notified.set(terminal.id, { context: turnContext(turn), kind: "failed" })
    }
  }

  // A done report is the finish the person wants to hear of: its terminal's one notification.
  const announceDone = (
    entries: readonly DoneEntry[],
    snapshot: Workspace,
    terminals: Terminals,
  ): void => {
    const { pageFocused, preferences } = ui.getSnapshot()
    if (!notify || !preferences.notifyFinished || pageFocused) return
    const newest = new Map<string, DoneEntry>()
    for (const entry of entries) {
      const key = `${entryContext(entry)}/${entry.source.terminalId}`
      const known = newest.get(key)
      if (!known || entry.at >= known.at) newest.set(key, entry)
    }
    for (const [key, entry] of newest) {
      const terminal = terminals.get(key)
      const context = entryContext(entry)
      if (!terminal || leadHearsOf(snapshot, context, entry.source.terminalId)) continue
      notify({ id: terminal.id, ...doneNotice(terminal, entry.update) }, entry.id)
      notified.set(terminal.id, { context, kind: "done" })
    }
  }

  // Takes back the notification of each terminal with nothing left unseen: no failed row, or
  // no done report, as it was about.
  const sweep = (rows: readonly InboxTurn[], entries: readonly DoneEntry[]): void => {
    const unread = unreadOfTurns(rows)
    for (const [id, { context, kind }] of notified) {
      const [projectId, workspaceSessionId] = [
        context.slice(0, context.indexOf("/")),
        context.slice(context.indexOf("/") + 1),
      ]
      const standing =
        kind === "done"
          ? terminalDone(entries, { projectId, workspaceSessionId, terminalId: id })
          : unreadEnd(unread, context, id) === "failed"
      if (!standing) {
        notified.delete(id)
        clear?.(id)
      }
    }
  }

  // Reading can answer at once with a change of the rows; that run waits for this one.
  const follow = (): void => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        run()
      } while (again)
    } finally {
      running = false
    }
  }
  follow()
  const stops = [
    turns.subscribe(follow),
    items.subscribe(follow),
    workspace.subscribe(follow),
    ui.subscribe(follow),
  ]
  return () => stops.forEach((stop) => stop())
}
