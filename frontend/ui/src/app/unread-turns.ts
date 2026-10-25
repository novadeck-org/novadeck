import { finishNotice } from "@novadeck/core/agent-finish"
import type { Inbox, InboxTurn } from "@novadeck/core/inbox"
import { leadHearsOf } from "@novadeck/core/inbox-items"
import type { Store } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"

import { sameUnread, turnContext, unreadEnd, unreadOfTurns } from "../terminals/unread-state"
import { viewing, type UiStore } from "./ui-store"

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

// Follows the stored finished turns of the Inbox (`inbox.turns`) for the rest of the app.
//
// The terminals' unread marks (`ui.unread`) mirror them: each terminal with unread rows
// carries how its newest row ended, rows the Inbox hides under a running lead included. The
// marks outlast the agent's next turn, as the rows do.
//
// Looking reads: the rows of the terminal the person views (the selected one while the page
// has their focus), as they come in and, on a focused launch, as they were stored.
//
// A row that is new tells `notify`, where given and the person wants it, once, only while
// the page hasn't their focus and not for a worker whose lead's agent runs, as that lead
// hears of it. A terminal has one notification, its newest row replacing the last, and
// `clear` takes it back once the terminal has no unread rows. A row is new if no listing
// held it before and it did not end before this started; the first listing, and the first
// after the backend lost its rows, only takes in what it holds.
//
// `gist`, where given, is asked once for each row without one, whose terminal the person
// isn't viewing and whose end is its agent's current, so murmur can write the gist.
export const watchUnreadTurns = (
  inbox: Pick<Inbox, "turns" | "readFinishes">,
  workspace: Store<Workspace>,
  ui: UiStore,
  {
    notify,
    clear,
    gist,
  }: {
    notify?: FinishNotify | undefined
    clear?: ((terminalId: string) => void) | undefined
    gist?: ((terminalId: string, at: number) => void) | undefined
  } = {},
): (() => void) => {
  const { turns, readFinishes } = inbox
  if (!turns) return () => {}
  const startedAt = Date.now()
  // Every row id any listing held since the last baseline.
  let listed: Set<string> | undefined
  // The rows asked to be read, and those asked a gist for, while listed.
  let asked = new Set<string>()
  let gisted = new Set<string>()
  // The terminals whose notification stands, by id, with their session context.
  const notified = new Map<string, string>()
  let running = false
  let again = false

  const run = (): void => {
    const list = turns.getSnapshot()
    const snapshot = workspace.getSnapshot()
    const state = ui.getSnapshot()
    if (list === undefined) {
      listed = undefined
      asked = new Set()
      gisted = new Set()
      mirror([])
      sweep([])
      return
    }
    const looking = viewing(snapshot, state)
    const viewed = (turn: InboxTurn): boolean =>
      looking?.context === turnContext(turn) && looking.id === turn.terminalId
    const before = listed
    const fresh = before ? list.filter((turn) => !before.has(turn.id)) : []
    listed = new Set([...(before ?? []), ...list.map((turn) => turn.id)])
    const terminals = terminalsOf(snapshot)
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
    sweep(unviewed.filter((turn) => !heard(turn)))
    wordsFor(unviewed, terminals)
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
      const key = `${turnContext(turn)}/${turn.terminalId}`
      const known = newest.get(key)
      if (!known || turn.at >= known.at) newest.set(key, turn)
    }
    for (const turn of newest.values()) {
      const terminal = terminalOf(terminals, turn)
      if (!terminal || leadHearsOf(snapshot, turnContext(turn), turn.terminalId)) continue
      const failed = turn.outcome === "failed"
      // A failed turn is trouble in the Inbox, which pings of its own where the person wants
      // what needs them: one notification for it, not two.
      if (failed && preferences.notifyNeeds) continue
      notify(
        {
          id: terminal.id,
          ...finishNotice(
            terminal,
            turn.reply === null ? { failed } : { failed, reply: turn.reply },
          ),
        },
        turn.id,
      )
      notified.set(terminal.id, turnContext(turn))
    }
  }

  // Takes back the notification of each terminal with no unread row left.
  const sweep = (rows: readonly InboxTurn[]): void => {
    const unread = unreadOfTurns(rows)
    for (const [id, context] of notified)
      if (!unreadEnd(unread, context, id)) {
        notified.delete(id)
        clear?.(id)
      }
  }

  const wordsFor = (rows: readonly InboxTurn[], terminals: Terminals): void => {
    gisted = new Set([...gisted].filter((id) => rows.some((turn) => turn.id === id)))
    if (!gist) return
    for (const turn of rows) {
      if (turn.gist !== null || gisted.has(turn.id)) continue
      const terminal = terminalOf(terminals, turn)
      if (terminal?.state !== "running" || terminal.agent?.lastTurn?.at !== turn.at) continue
      gisted.add(turn.id)
      gist(turn.terminalId, turn.at)
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
  const stops = [turns.subscribe(follow), workspace.subscribe(follow), ui.subscribe(follow)]
  return () => stops.forEach((stop) => stop())
}
