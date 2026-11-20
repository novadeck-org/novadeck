import { agentWorking } from "../agents/finish"
import type { ChatAnswer, ChatRequest } from "../conversation"
import {
  maxResolved,
  ordered,
  rowKey,
  type InboxRow,
  type InboxSource,
  type SettledHow,
} from "../inbox"
import type { MessagesState } from "../messages"
import { isAgentProgram } from "../terminals/process"
import type { TerminalMetadata, Workspace } from "../types"
import { second } from "../units"

// The Inbox's history of what the app made resolved. The runner lists the asks, tells and done
// reports it holds as resolved itself; the rows the app derives from live state (a dialog, a
// held message, a usage limit, a failed turn, messages waiting) are only there while the
// condition lasts. This watches the open rows of a backend that derives them, and when one
// stops being there it keeps a resolved copy of it, with how it ended, so it joins the history:
// the latest `maxResolved` of it, across all the Inbox. The backend keeps what it is told to
// `save`, so the history survives a restart. Pure but for the clock and `save`.

// How long what the person did to a row (`note`) may take to end it: a note older than this
// belongs to an action that didn't, as a dialog answered and then found still waiting.
export const noteMs = 60 * second

// How soon after a row was kept resolved the same id standing open again takes it back: a
// request that went and came again in a moment (a dialog read twice, a stream that reconnected)
// is one row, not an ended one and a new one.
export const reopenMs = 5 * second

// How long after the backend's streams are steady, first or again, a row kept open from before
// that is not there is taken to have ended while the app was away: its streams need a moment to
// list what is there.
export const awayMs = 3 * second

// How long a saved row's text may run, and how many of its list items, before it is cut; and how
// many bytes the saved rows may weigh together, so what the runner is sent stays well within
// what its connection takes in one message.
const textCap = 2000
const listCap = 20
export const savedBytes = 64_000

// How many open rows are kept beside the resolved ones, for the app to find after it was away.
export const maxKeptOpen = 50

// What the backend knows beyond the rows themselves, to tell how one ended.
export type HistoryFacts = {
  readonly workspace: Workspace
  readonly messages: MessagesState
}

export type HistoryView = {
  // When to look again, in milliseconds from now, for what waits on a moment; undefined where
  // nothing does.
  readonly wake?: number
  // The rows, the resolved ones among them, newest first (`ordered`).
  readonly rows: readonly InboxRow[]
  // The failed turns of agents that have moved on, resolved now: the backend reads their
  // stored rows, so they are not listed again.
  readonly read: readonly string[]
}

export type InboxHistory = {
  // `steady` false while the backend can't tell what is open (its listing is out, as after a
  // reconnection): rows missing then are not taken to have ended.
  readonly view: (found: readonly InboxRow[], facts: HistoryFacts, steady?: boolean) => HistoryView
  // Says how the row `id` ends, where the person did it (the dialog answered here, a held
  // thread released), and with what words; used when it does end.
  readonly note: (id: string, how: SettledHow, answer?: string) => void
  // Takes a note back, as the action it was for failed.
  readonly forget: (id: string) => void
}

export type InboxHistoryOptions = {
  // The rows as `save` kept them last (see `parseHistory`): the resolved ones, and the open
  // ones the app had when it stopped.
  readonly saved?: readonly InboxRow[]
  readonly save: (rows: readonly InboxRow[]) => void
  readonly now?: () => number
}

// A stored failed turn that is no longer the agent's current end: it only informs, and is
// resolved on sight.
export const moved = (row: InboxRow): boolean =>
  !row.settled &&
  row.kind === "trouble" &&
  row.trouble.type === "failed" &&
  !!row.trouble.stored &&
  !row.stopped

// The terminal a row came from, where the workspace still has it.
export const terminalOf = (
  workspace: Workspace,
  source: InboxSource,
): TerminalMetadata | undefined =>
  workspace.projects
    .find((project) => project.id === source.projectId)
    ?.history.find((session) => session.id === source.workspaceSessionId)
    ?.state.roster.terminals.find((terminal) => terminal.id === source.terminalId)

// Whether the agent that made the row is still in its terminal, awake.
const present = (terminal: TerminalMetadata | undefined, agent: string): boolean =>
  terminal !== undefined &&
  terminal.state === "running" &&
  isAgentProgram(terminal.process) &&
  terminal.process === agent

// Whether the messages for the row's terminal were delivered since the row began.
const delivered = ({ terminals }: MessagesState, row: InboxRow): boolean =>
  Object.values(terminals)
    .flatMap((listing) => listing.threads)
    .flatMap((thread) => thread.messages)
    .some(
      (message) =>
        message.to.kind === "agent" &&
        message.to.terminalId === row.source.terminalId &&
        message.state === "delivered" &&
        (message.deliveredAt ?? 0) >= row.at,
    )

// How a row ended when the person did nothing the backend noted: with its agent asleep or gone,
// or its terminal closed, `ended`; a dialog by whether the agent went on working (answered in
// its terminal) or rested (closed there, by a No or Escape, which looks alike); a held message
// by what the messages say of its thread; waiting messages by whether any were delivered.
const endedHow = (row: InboxRow, { workspace, messages }: HistoryFacts): SettledHow => {
  const terminal = terminalOf(workspace, row.source)
  if (!present(terminal, row.source.agent)) return "ended"
  switch (row.kind) {
    case "request":
      return row.request.answered
        ? "answered"
        : terminal && agentWorking(terminal)
          ? "terminal"
          : "gone"
    case "held": {
      const thread = Object.values(messages.terminals)
        .flatMap((listing) => listing.threads)
        .find((each) => each.id === row.held.threadId)
      if (!thread) return "ended"
      return thread.messages.some((message) => message.state === "gone") ? "stopped" : "released"
    }
    case "trouble":
      if (row.trouble.type !== "waits") return "worked"
      return delivered(messages, row) ? "delivered" : "gone"
    default:
      return "ended"
  }
}

// What the person answered a dialog with, as one line: the option they picked, with their words;
// the options they picked for each question; or that they talked it over, or filled in or
// declined its form.
export const answerLine = (request: ChatRequest, answer: ChatAnswer): string => {
  const { dialog } = request
  switch (answer.type) {
    case "choice": {
      const label =
        dialog?.type === "choices"
          ? dialog.options.find((option) => option.id === answer.option)?.label
          : undefined
      return [label ?? answer.option, answer.text?.trim()].filter(Boolean).join(": ")
    }
    case "questions":
      return answer.answers
        .map((each) => {
          const question =
            dialog?.type === "questions"
              ? dialog.questions.find((one) => one.id === each.question)
              : undefined
          const picked = each.options.map(
            (id) => question?.options.find((option) => option.id === id)?.label ?? id,
          )
          return [...picked, each.text?.trim()].filter(Boolean).join(", ")
        })
        .filter(Boolean)
        .join(" · ")
    case "chat":
      return "Set aside to talk it over in the terminal"
    case "form":
      return answer.action === "accept" ? "Filled in the form" : "Declined the form"
  }
}

// What a saved row must hold to be read back: a newer or older build's rows that don't are
// left out.
const readable = (value: unknown): value is InboxRow => {
  if (typeof value !== "object" || value === null) return false
  const row = value as Partial<Record<keyof InboxRow, unknown>>
  const { source, settled } = row
  return (
    typeof row.id === "string" &&
    typeof row.kind === "string" &&
    typeof row.at === "number" &&
    typeof source === "object" &&
    source !== null &&
    typeof (source as Partial<InboxSource>).terminalId === "string" &&
    (settled === undefined ||
      (typeof settled === "object" &&
        settled !== null &&
        typeof (settled as { at?: unknown }).at === "number"))
  )
}

// The rows as the runner kept them (`JSON` each), those that can't be read left out.
export const parseHistory = (saved: readonly string[]): InboxRow[] =>
  saved.flatMap((text) => {
    try {
      const row: unknown = JSON.parse(text)
      return readable(row) ? [row] : []
    } catch {
      return []
    }
  })

// A row as it is kept: what the person looked at and set aside are theirs to forget.
export const keptRow = (row: InboxRow): string => {
  const { snoozed: _snoozed, ...rest } = row
  return JSON.stringify(rest)
}

// A text or list cut to what a kept row may hold, a cut text saying so.
const cut = (value: unknown): unknown => {
  if (typeof value === "string")
    return value.length > textCap ? `${value.slice(0, textCap)}… (cut)` : value
  if (Array.isArray(value)) return value.slice(0, listCap).map(cut)
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, cut(each)]))
  return value
}

// A row as it is kept: its long texts and lists cut, so a dialog's whole detail or an agent's
// whole report is not what the runner is sent. The card of a kept row shows what is left.
export const trimmedRow = (row: InboxRow): InboxRow => cut(row) as InboxRow

// The rows that fit the bytes a save may weigh, the oldest dropped first.
export const fitted = (rows: readonly InboxRow[]): InboxRow[] => {
  let weight = rows.reduce((sum, row) => sum + keptRow(row).length, 0)
  const kept = [...rows]
  while (weight > savedBytes && kept.length > 0) weight -= keptRow(kept.shift()!).length
  return kept
}

// The rows the app derives itself, which the runner can't tell the end of (its own entries,
// asks, tells and done reports, it lists resolved itself).
const derived = (row: InboxRow): boolean =>
  row.kind === "request" || row.kind === "held" || row.kind === "trouble"

export const createInboxHistory = ({
  saved = [],
  save,
  now = Date.now,
}: InboxHistoryOptions): InboxHistory => {
  // The resolved rows it keeps, the latest last; the open rows the last view saw; the open rows
  // the app had when it stopped, until it is steady and can tell which of them ended meanwhile;
  // and what was last saved.
  let history: readonly InboxRow[] = saved
    .filter((row) => row.settled)
    .toSorted((a, b) => a.settled!.at - b.settled!.at)
    .slice(-maxResolved)
    .map(trimmedRow)
  let before = new Map<string, InboxRow>()
  let away: readonly InboxRow[] = saved.filter((row) => !row.settled && derived(row))
  let steadySince: number | undefined
  let lastSaved = ""
  const notes = new Map<string, { how: SettledHow; answer: string | undefined; at: number }>()
  // A copy listed under another id while its own is taken by a newer row, kept the same.
  const renamed = new WeakMap<InboxRow, InboxRow>()

  const resolve = (row: InboxRow, facts: HistoryFacts, fallback?: SettledHow): InboxRow => {
    const at = now()
    const note = notes.get(row.id)
    notes.delete(row.id)
    const noted = note && at - note.at <= noteMs ? note : undefined
    const how = noted?.how ?? fallback ?? endedHow(row, facts)
    const { snoozed: _snoozed, ...rest } = row
    const answer = noted?.answer
    return trimmedRow({
      ...rest,
      stopped: false,
      settled: { how, at, ...(answer !== undefined && answer !== "" && { answer }) },
    } as InboxRow)
  }

  // Saves the resolved rows and the open ones, as many as fit, when they changed.
  const persist = (open: readonly InboxRow[]): void => {
    const rows = fitted([...history, ...open.filter(derived).slice(-maxKeptOpen).map(trimmedRow)])
    const text = JSON.stringify(rows.map(keptRow))
    if (text === lastSaved) return
    lastSaved = text
    save(rows)
  }

  const view = (found: readonly InboxRow[], facts: HistoryFacts, steady = true): HistoryView => {
    // A request that goes and comes again in a moment, whatever its time then, is one row;
    // any other row kept resolved that stands open again, as an ask whose session came back,
    // is open, if it is the same row.
    const standing = new Map(found.filter((row) => !row.settled).map((row) => [row.id, row]))
    const reopened = history.filter((row) => {
      const again = standing.get(row.id)
      if (again === undefined || moved(again)) return false
      if (rowKey(again) === rowKey(row)) return true
      return row.kind === "request" && now() - row.settled!.at < reopenMs
    })
    if (reopened.length > 0) history = history.filter((row) => !reopened.includes(row))
    const resolvedKeys = new Set(history.map(rowKey))
    // The rows still open: a failed turn that moved on, or one already kept resolved, whose
    // stored row the backend is yet to read, is not.
    const open = found.filter(
      (row) => !row.settled && !moved(row) && !resolvedKeys.has(rowKey(row)),
    )
    const retiring = found.filter((row) => moved(row) && !resolvedKeys.has(rowKey(row)))
    const read = found.filter((row) => moved(row)).map(({ id }) => id)
    const listed = new Set(found.filter((row) => row.settled).map(({ id }) => id))
    const openKeys = new Set(open.map(rowKey))
    const made: InboxRow[] = []
    let wake: number | undefined
    if (steady) {
      for (const [key, row] of before)
        if (!openKeys.has(key) && !listed.has(row.id) && derived(row))
          made.push(resolve(row, facts))
      before = new Map(open.filter(derived).map((row) => [rowKey(row), row]))
      steadySince ??= now()
      // What was open when the app stopped and is not there once its streams had their moment
      // ended while it was away.
      if (away.length > 0) {
        const left = steadySince + awayMs - now()
        if (left > 0) wake = left
        else {
          const here = new Set(found.map(rowKey))
          for (const row of away) if (!here.has(rowKey(row))) made.push(resolve(row, facts, "away"))
          away = []
        }
      }
    }
    for (const row of retiring) made.push(resolve(row, facts, "worked"))
    for (const row of made)
      history = [...history.filter((each) => rowKey(each) !== rowKey(row)), row]
    if (made.length > 0)
      history = history.toSorted((a, b) => a.settled!.at - b.settled!.at).slice(-maxResolved)
    if (steady && away.length === 0) persist(open)
    // The ids the rows listed now hold: a copy under one of them is listed under its own.
    const taken = new Set([...open, ...found.filter((row) => row.settled)].map(({ id }) => id))
    const copies = history
      .filter((row) => !listed.has(row.id))
      .map((row) => {
        if (!taken.has(row.id)) return row
        const other = renamed.get(row) ?? { ...row, id: `${row.id}~${row.at}` }
        renamed.set(row, other)
        return other
      })
    return {
      rows: ordered([...open, ...found.filter((row) => row.settled), ...copies]),
      read,
      ...(wake !== undefined && { wake }),
    }
  }

  return {
    view,
    note: (id, how, answer) => {
      notes.set(id, { how, answer, at: now() })
    },
    forget: (id) => {
      notes.delete(id)
    },
  }
}
