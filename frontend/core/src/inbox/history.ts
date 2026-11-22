import { agentWorking } from "../agents/finish"
import type { ChatAnswer, ChatRequest } from "../conversation"
import {
  maxResolved,
  ordered,
  entryKey,
  type InboxEntry,
  type InboxSource,
  type SettledHow,
} from "../inbox"
import type { MessagesState } from "../messages"
import { isAgentProgram } from "../terminals/process"
import type { TerminalMetadata, Workspace } from "../types"
import { second } from "../units"

// The Inbox's history of what the app made resolved. The runner lists the asks, tells and done
// reports it holds as resolved itself; the entries the app derives from live state (a dialog, a
// held message, a usage limit, a failed turn, messages waiting) are only there while the
// condition lasts. This watches the open entries of a backend that derives them, and when one
// stops being there it keeps a resolved copy of it, with how it ended, so it joins the history:
// the latest `maxResolved` of it, across all the Inbox. The backend keeps what it is told to
// `save`, so the history survives a restart. Pure but for the clock and `save`.

// How long what the person did to an entry (`note`) may take to end it: a note older than this
// belongs to an action that didn't, as a dialog answered and then found still waiting.
export const noteMs = 60 * second

// How soon after an entry was kept resolved the same id standing open again takes it back: a
// request that went and came again in a moment (a dialog read twice, a stream that reconnected)
// is one entry, not an ended one and a new one.
export const reopenMs = 5 * second

// How long after the backend's streams are steady, first or again, an entry kept open from before
// that is not there is taken to have ended while the app was away: its streams need a moment to
// list what is there.
export const awayMs = 3 * second

// How long a saved entry's text may run, and how many of its list items, before it is cut; and how
// many bytes the saved entries may weigh together, so what the runner is sent stays well within
// what its connection takes in one message.
const textCap = 2000
const listCap = 20
export const savedBytes = 64_000

// How many open entries are kept beside the resolved ones, for the app to find after it was away.
export const maxKeptOpen = 50

// What the backend knows beyond the entries themselves, to tell how one ended.
export type HistoryFacts = {
  readonly workspace: Workspace
  readonly messages: MessagesState
}

export type HistoryView = {
  // When to look again, in milliseconds from now, for what waits on a moment; undefined where
  // nothing does.
  readonly wake?: number
  // The entries, the resolved ones among them, newest first (`ordered`).
  readonly entries: readonly InboxEntry[]
  // The failed turns of agents that have moved on, resolved now: the backend reads their
  // stored entries, so they are not listed again.
  readonly read: readonly string[]
}

export type InboxHistory = {
  // `steady` false while the backend can't tell what is open (its listing is out, as after a
  // reconnection): entries missing then are not taken to have ended.
  readonly view: (
    found: readonly InboxEntry[],
    facts: HistoryFacts,
    steady?: boolean,
  ) => HistoryView
  // Says how the entry `id` ends, where the person did it (the dialog answered here, a held
  // thread released), and with what words; used when it does end.
  readonly note: (id: string, how: SettledHow, answer?: string) => void
  // Takes a note back, as the action it was for failed.
  readonly forget: (id: string) => void
}

export type InboxHistoryOptions = {
  // The entries as `save` kept them last (see `parseHistory`): the resolved ones, and the open
  // ones the app had when it stopped.
  readonly saved?: readonly InboxEntry[]
  readonly save: (entries: readonly InboxEntry[]) => void
  readonly now?: () => number
}

// A stored failed turn that is no longer the agent's current end: it only informs, and is
// resolved on sight.
export const moved = (entry: InboxEntry): boolean =>
  !entry.settled &&
  entry.kind === "trouble" &&
  entry.trouble.type === "failed" &&
  !!entry.trouble.stored &&
  !entry.stopped

// The terminal an entry came from, where the workspace still has it.
export const terminalOf = (
  workspace: Workspace,
  source: InboxSource,
): TerminalMetadata | undefined =>
  workspace.projects
    .find((project) => project.id === source.projectId)
    ?.history.find((session) => session.id === source.workspaceSessionId)
    ?.state.roster.terminals.find((terminal) => terminal.id === source.terminalId)

// Whether the agent that made the entry is still in its terminal, awake.
const present = (terminal: TerminalMetadata | undefined, agent: string): boolean =>
  terminal !== undefined &&
  terminal.state === "running" &&
  isAgentProgram(terminal.process) &&
  terminal.process === agent

// Whether the messages for the entry's terminal were delivered since the entry began.
const delivered = ({ terminals }: MessagesState, entry: InboxEntry): boolean =>
  Object.values(terminals)
    .flatMap((listing) => listing.threads)
    .flatMap((thread) => thread.messages)
    .some(
      (message) =>
        message.to.kind === "agent" &&
        message.to.terminalId === entry.source.terminalId &&
        message.state === "delivered" &&
        (message.deliveredAt ?? 0) >= entry.at,
    )

// How an entry ended when the person did nothing the backend noted: with its agent asleep or gone,
// or its terminal closed, `ended`; a dialog by whether the agent went on working (answered in
// its terminal) or rested (closed there, by a No or Escape, which looks alike); a held message
// by what the messages say of its thread; waiting messages by whether any were delivered.
const endedHow = (entry: InboxEntry, { workspace, messages }: HistoryFacts): SettledHow => {
  const terminal = terminalOf(workspace, entry.source)
  if (!present(terminal, entry.source.agent)) return "ended"
  switch (entry.kind) {
    case "request":
      return entry.request.answered
        ? "answered"
        : terminal && agentWorking(terminal)
          ? "terminal"
          : "gone"
    case "held": {
      const thread = Object.values(messages.terminals)
        .flatMap((listing) => listing.threads)
        .find((each) => each.id === entry.held.threadId)
      if (!thread) return "ended"
      return thread.messages.some((message) => message.state === "gone") ? "stopped" : "released"
    }
    case "trouble":
      if (entry.trouble.type !== "waits") return "worked"
      return delivered(messages, entry) ? "delivered" : "gone"
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

// What a saved entry must hold to be read back: a newer or older build's entries that don't are
// left out.
const readable = (value: unknown): value is InboxEntry => {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Partial<Record<keyof InboxEntry, unknown>>
  const { source, settled } = entry
  return (
    typeof entry.id === "string" &&
    typeof entry.kind === "string" &&
    typeof entry.at === "number" &&
    typeof source === "object" &&
    source !== null &&
    typeof (source as Partial<InboxSource>).terminalId === "string" &&
    (settled === undefined ||
      (typeof settled === "object" &&
        settled !== null &&
        typeof (settled as { at?: unknown }).at === "number"))
  )
}

// The entries as the runner kept them (`JSON` each), those that can't be read left out.
export const parseHistory = (saved: readonly string[]): InboxEntry[] =>
  saved.flatMap((text) => {
    try {
      const entry: unknown = JSON.parse(text)
      return readable(entry) ? [entry] : []
    } catch {
      return []
    }
  })

// An entry as it is kept: what the person looked at and set aside are theirs to forget.
export const keptEntry = (entry: InboxEntry): string => {
  const { snoozed: _snoozed, ...rest } = entry
  return JSON.stringify(rest)
}

// A text or list cut to what a kept entry may hold, a cut text saying so.
const cut = (value: unknown): unknown => {
  if (typeof value === "string")
    return value.length > textCap ? `${value.slice(0, textCap)}… (cut)` : value
  if (Array.isArray(value)) return value.slice(0, listCap).map(cut)
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, cut(each)]))
  return value
}

// An entry as it is kept: its long texts and lists cut, so a dialog's whole detail or an agent's
// whole report is not what the runner is sent. The card of a kept entry shows what is left.
export const trimmedEntry = (entry: InboxEntry): InboxEntry => cut(entry) as InboxEntry

// The entries that fit the bytes a save may weigh, the oldest dropped first.
export const fitted = (entries: readonly InboxEntry[]): InboxEntry[] => {
  let weight = entries.reduce((sum, entry) => sum + keptEntry(entry).length, 0)
  const kept = [...entries]
  while (weight > savedBytes && kept.length > 0) weight -= keptEntry(kept.shift()!).length
  return kept
}

// The entries the app derives itself, which the runner can't tell the end of (its own entries,
// asks, tells and done reports, it lists resolved itself).
const derived = (entry: InboxEntry): boolean =>
  entry.kind === "request" || entry.kind === "held" || entry.kind === "trouble"

export const createInboxHistory = ({
  saved = [],
  save,
  now = Date.now,
}: InboxHistoryOptions): InboxHistory => {
  // The resolved entries it keeps, the latest last; the open entries the last view saw; the open entries
  // the app had when it stopped, until it is steady and can tell which of them ended meanwhile;
  // and what was last saved.
  let history: readonly InboxEntry[] = saved
    .filter((entry) => entry.settled)
    .toSorted((a, b) => a.settled!.at - b.settled!.at)
    .slice(-maxResolved)
    .map(trimmedEntry)
  let before = new Map<string, InboxEntry>()
  let away: readonly InboxEntry[] = saved.filter((entry) => !entry.settled && derived(entry))
  let steadySince: number | undefined
  let lastSaved = ""
  const notes = new Map<string, { how: SettledHow; answer: string | undefined; at: number }>()
  // A copy listed under another id while its own is taken by a newer entry, kept the same.
  const renamed = new WeakMap<InboxEntry, InboxEntry>()

  const resolve = (entry: InboxEntry, facts: HistoryFacts, fallback?: SettledHow): InboxEntry => {
    const at = now()
    const note = notes.get(entry.id)
    notes.delete(entry.id)
    const noted = note && at - note.at <= noteMs ? note : undefined
    const how = noted?.how ?? fallback ?? endedHow(entry, facts)
    const { snoozed: _snoozed, ...rest } = entry
    const answer = noted?.answer
    return trimmedEntry({
      ...rest,
      stopped: false,
      settled: { how, at, ...(answer !== undefined && answer !== "" && { answer }) },
    } as InboxEntry)
  }

  // Saves the resolved entries and the open ones, as many as fit, when they changed.
  const persist = (open: readonly InboxEntry[]): void => {
    const entries = fitted([
      ...history,
      ...open.filter(derived).slice(-maxKeptOpen).map(trimmedEntry),
    ])
    const text = JSON.stringify(entries.map(keptEntry))
    if (text === lastSaved) return
    lastSaved = text
    save(entries)
  }

  const view = (found: readonly InboxEntry[], facts: HistoryFacts, steady = true): HistoryView => {
    // A request that goes and comes again in a moment, whatever its time then, is one entry;
    // any other entry kept resolved that stands open again, as an ask whose session came back,
    // is open, if it is the same entry.
    const standing = new Map(
      found.filter((entry) => !entry.settled).map((entry) => [entry.id, entry]),
    )
    const reopened = history.filter((entry) => {
      const again = standing.get(entry.id)
      if (again === undefined || moved(again)) return false
      if (entryKey(again) === entryKey(entry)) return true
      return entry.kind === "request" && now() - entry.settled!.at < reopenMs
    })
    if (reopened.length > 0) history = history.filter((entry) => !reopened.includes(entry))
    const resolvedKeys = new Set(history.map(entryKey))
    // The entries still open: a failed turn that moved on, or one already kept resolved, whose
    // stored entry the backend is yet to read, is not.
    const open = found.filter(
      (entry) => !entry.settled && !moved(entry) && !resolvedKeys.has(entryKey(entry)),
    )
    const retiring = found.filter((entry) => moved(entry) && !resolvedKeys.has(entryKey(entry)))
    const read = found.filter((entry) => moved(entry)).map(({ id }) => id)
    const listed = new Set(found.filter((entry) => entry.settled).map(({ id }) => id))
    const openKeys = new Set(open.map(entryKey))
    const made: InboxEntry[] = []
    let wake: number | undefined
    if (steady) {
      for (const [key, entry] of before)
        if (!openKeys.has(key) && !listed.has(entry.id) && derived(entry))
          made.push(resolve(entry, facts))
      before = new Map(open.filter(derived).map((entry) => [entryKey(entry), entry]))
      steadySince ??= now()
      // What was open when the app stopped and is not there once its streams had their moment
      // ended while it was away.
      if (away.length > 0) {
        const left = steadySince + awayMs - now()
        if (left > 0) wake = left
        else {
          const here = new Set(found.map(entryKey))
          for (const entry of away)
            if (!here.has(entryKey(entry))) made.push(resolve(entry, facts, "away"))
          away = []
        }
      }
    }
    for (const entry of retiring) made.push(resolve(entry, facts, "worked"))
    for (const entry of made)
      history = [...history.filter((each) => entryKey(each) !== entryKey(entry)), entry]
    if (made.length > 0)
      history = history.toSorted((a, b) => a.settled!.at - b.settled!.at).slice(-maxResolved)
    if (steady && away.length === 0) persist(open)
    // The ids the entries listed now hold: a copy under one of them is listed under its own.
    const taken = new Set([...open, ...found.filter((entry) => entry.settled)].map(({ id }) => id))
    const copies = history
      .filter((entry) => !listed.has(entry.id))
      .map((entry) => {
        if (!taken.has(entry.id)) return entry
        const other = renamed.get(entry) ?? { ...entry, id: `${entry.id}~${entry.at}` }
        renamed.set(entry, other)
        return other
      })
    return {
      entries: ordered([...open, ...found.filter((entry) => entry.settled), ...copies]),
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
