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

// What the backend knows beyond the rows themselves, to tell how one ended.
export type HistoryFacts = {
  readonly workspace: Workspace
  readonly messages: MessagesState
}

export type HistoryView = {
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
  // The rows as `save` kept them last (see `parseHistory`).
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

const terminalOf = (workspace: Workspace, source: InboxSource): TerminalMetadata | undefined =>
  workspace.projects
    .find((project) => project.id === source.projectId)
    ?.history.find((session) => session.id === source.workspaceSessionId)
    ?.state.roster.terminals.find((terminal) => terminal.id === source.terminalId)

// Whether the agent that made the row is still in its terminal.
const present = (terminal: TerminalMetadata | undefined, agent: string): boolean =>
  terminal !== undefined &&
  (terminal.state === "sleeping"
    ? terminal.agent === agent
    : terminal.state === "running" &&
      isAgentProgram(terminal.process) &&
      terminal.process === agent)

// How a row ended when the person did nothing the backend noted: with its agent or terminal
// gone, `ended`; a dialog by whether the agent went on working (answered in its terminal) or
// rested (its turn interrupted); a held message by what the messages say of its thread.
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
      return row.trouble.type === "waits" ? "delivered" : "worked"
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
    typeof settled === "object" &&
    settled !== null &&
    typeof (settled as { at?: unknown }).at === "number"
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

export const createInboxHistory = ({
  saved = [],
  save,
  now = Date.now,
}: InboxHistoryOptions): InboxHistory => {
  // The resolved rows it keeps, the latest last, and the open rows the last view saw.
  let history: readonly InboxRow[] = saved.slice(-maxResolved)
  let before = new Map<string, InboxRow>()
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
    return {
      ...rest,
      stopped: false,
      settled: { how, at, ...(answer !== undefined && answer !== "" && { answer }) },
    } as InboxRow
  }

  const view = (found: readonly InboxRow[], facts: HistoryFacts, steady = true): HistoryView => {
    // A row kept resolved that stands open again, as an ask whose session came back, is open;
    // so is one whose id stands again within a moment.
    const standing = new Map(found.filter((row) => !row.settled).map((row) => [row.id, row]))
    const reopened = history.filter((row) => {
      const again = standing.get(row.id)
      if (again === undefined || moved(again)) return false
      return rowKey(again) === rowKey(row) || now() - row.settled!.at < reopenMs
    })
    if (reopened.length > 0) {
      history = history.filter((row) => !reopened.includes(row))
      save(history)
    }
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
    if (steady) {
      for (const [key, row] of before)
        if (!openKeys.has(key) && !listed.has(row.id)) made.push(resolve(row, facts))
      before = new Map(open.map((row) => [rowKey(row), row]))
    }
    for (const row of retiring) made.push(resolve(row, facts, "worked"))
    for (const row of made)
      history = [...history.filter((each) => rowKey(each) !== rowKey(row)), row]
    if (made.length > 0) {
      history = history.toSorted((a, b) => a.settled!.at - b.settled!.at).slice(-maxResolved)
      save(history)
    }
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
