import type { ChatAnswer, ChatRequest } from "./conversation"
import type { AgentName } from "./harnesses"
import type { MessageWaits } from "./messages"
import { createStore, type Store } from "./store"
import type { Workspace } from "./types"

// The Inbox: everything across the workspace that an agent, or Novadeck about an agent,
// puts in front of the person, each as its own row. The person reads and answers it
// there, without going to the terminal. Each row comes from one of five sources, and the UI
// presents it as one of four types:
// - `request`: a prompt the agent's harness shows and Novadeck reads from its screen
//   (`ChatRequest`, as the chat view has it). A permission or plan is an Unblock, a
//   question an Ask; a dialog Novadeck can't read (`raw`) is answered in the terminal.
// - `held`: a message between two agents that Novadeck holds until the person releases
//   it, as its two agents kept messaging while neither worked (an Unblock).
// - `ask`: what the agent asked through Novadeck's MCP `ask` tool (an Ask, or an Unblock where
//   its answer is an action only the person can do, as a sign-in).
// - `trouble`: what Novadeck noticed about the agent: stuck, at a usage limit, failed, or
//   its messages held long behind what keeps the doorbell from waking it.
// - `update`: what the agent reported through the MCP `done` tool, or told through `tell`.
// Agents write subjects, bodies and options; Novadeck shows them as they are.

// Where a row comes from: the terminal, its project and session, the agent running in
// it, and its title as the sidebar shows it.
export type InboxSource = {
  readonly projectId: string
  readonly workspaceSessionId: string
  readonly terminalId: string
  // The terminal's handle, bare, such as `moth`: the UI writes it `@moth`.
  readonly handle: string
  readonly agent: AgentName
  readonly title: string
  readonly projectName: string
}

// An agent's answer shapes for `ask`: at most one of options or an action;
// none asks for the person's words. The person may always write their own answer.
export type AskOption = {
  readonly label: string
  readonly summary: string | null
  readonly details: string | null
  // A snippet to show under its details, as a migration: where it goes, and its text.
  readonly code: { readonly path: string; readonly text: string } | null
}
export type AskShape =
  | { readonly type: "text" }
  // `recommend` is the option the agent would pick, by index; null where it names none.
  | {
      readonly type: "options"
      readonly options: readonly AskOption[]
      readonly recommend: number | null
    }
  // Something only the person can do, as a login that opens a browser: the command, in
  // `directory`, and what the button that says it's done reads.
  | {
      readonly type: "action"
      readonly command: string
      readonly directory: string | null
      readonly doneLabel: string
    }

// What the agent asked. `body` and `details` are Markdown; `hardToUndo` says why the
// answer is hard to take back, where the agent says it is.
export type AgentAsk = {
  readonly subject: string
  readonly body: string
  readonly details: string | null
  readonly hardToUndo: string | null
  readonly shape: AskShape
}

// A held message: the thread's two terminals, by handle and title, the message, and why the
// thread is held (`loop`: its two agents kept messaging while neither worked; null: only
// that Novadeck holds it for the person).
export type HeldMessage = {
  readonly threadId: string
  readonly from: { readonly handle: string; readonly title: string }
  readonly to: { readonly handle: string; readonly title: string }
  readonly text: string
  readonly hop: number
  readonly heldFor: "loop" | null
}

// A line of the agent's tool calls as Novadeck read them, and how many times in a row it
// came again.
export type EvidenceLine = {
  readonly text: string
  readonly result: string | null
  readonly times: number
}

// What Novadeck noticed: the same failure again and again; a usage-limit window used up,
// with when it resets and whether Novadeck continues the agent then; a turn that ended in a
// failure, with the error where the harness gives it; or `count` messages that have waited
// long for the idle agent, behind what keeps the doorbell from waking it (`waits`, null
// where the doorbell hasn't said).
export type Trouble =
  | {
      readonly type: "stuck"
      readonly summary: string
      readonly evidence: readonly EvidenceLine[]
      // What Nudge sends after interrupting the agent.
      readonly nudge: string
    }
  | {
      readonly type: "limit"
      // The window's length in minutes, 0 where unknown, and when it resets, in epoch
      // milliseconds.
      readonly minutes: number
      readonly resetsAt: number
      // Whether Novadeck continues the agent at the reset; null where it can't, and the
      // sheet offers no switch.
      readonly autoResume: boolean | null
      readonly evidence: readonly EvidenceLine[]
    }
  // `stored` where it is a stored turn row (read by id), not a state derived from the
  // terminal's current end.
  | { readonly type: "failed"; readonly error: string | null; readonly stored?: true }
  | { readonly type: "waits"; readonly waits: MessageWaits | null; readonly count: number }

// What the agent reported through the MCP `done` tool (its task is finished), or told the
// person through `tell`. A finished turn alone makes none.
export type Update =
  | { readonly type: "done"; readonly subject: string; readonly body: string }
  | { readonly type: "told"; readonly subject: string; readonly body: string }

export type InboxContent =
  | { readonly kind: "request"; readonly request: ChatRequest }
  | { readonly kind: "held"; readonly held: HeldMessage }
  | { readonly kind: "ask"; readonly ask: AgentAsk }
  | { readonly kind: "trouble"; readonly trouble: Trouble }
  | { readonly kind: "update"; readonly update: Update }

// How an agent's ask ended without an answer from the Inbox, and when: the person dismissed
// it, its agent withdrew it, or the person wrote to the agent in its terminal.
export type AskSettled = {
  readonly how: "dismissed" | "withdrawn" | "replied"
  readonly at: number
}

// One row. `at` is when it started waiting, in epoch milliseconds. `stopped` whether the
// agent waits on the person (a gate, an ask after which it ended its turn, a stuck or
// failed agent) rather than working on. `seen` once the person opened it. `settled` only on
// an ask that no longer waits (see `AskSettled`): it stays listed until the person clears it.
export type InboxRow = InboxContent & {
  readonly id: string
  readonly source: InboxSource
  readonly at: number
  readonly stopped: boolean
  readonly seen: boolean
  readonly settled?: AskSettled
}

// The four ways the Inbox presents a row: Unblock (the agent can't go on without the
// person's yes or action), Ask (a question), Trouble and Update.
export type InboxType = "unblock" | "ask" | "trouble" | "update"

export const inboxType = (row: InboxContent): InboxType => {
  if (row.kind === "request") return row.request.kind === "question" ? "ask" : "unblock"
  if (row.kind === "held") return "unblock"
  if (row.kind === "ask" && row.ask.shape.type === "action") return "unblock"
  return row.kind
}

// The person's answer to a row, by its source: a dialog's answer as the chat sends it;
// a held thread released or stopped; an ask's option and/or words, or its
// action done; a stuck agent nudged with these words or stopped, auto-resume at a limit
// turned on or off, or the agent continued once the limit has reset; an update read.
export type InboxAnswer =
  | { readonly kind: "request"; readonly answer: ChatAnswer }
  | { readonly kind: "held"; readonly action: "release" | "stop" }
  | {
      readonly kind: "ask"
      readonly answer:
        | { readonly type: "reply"; readonly option: number | null; readonly text: string }
        | { readonly type: "done" }
    }
  | {
      readonly kind: "trouble"
      readonly action:
        // `own` when the person wrote the words, which take their asks out of the Inbox.
        | { readonly type: "nudge"; readonly text: string; readonly own?: true }
        | { readonly type: "stop" }
        // A limit that has reset: sends `continue` as the agent's next prompt, with no interrupt.
        | { readonly type: "continue" }
        | { readonly type: "auto-resume"; readonly on: boolean }
        // A failed turn that is no longer current, read.
        | { readonly type: "read" }
    }
  | { readonly kind: "update"; readonly action: "read" }

// Every row, waiting ones first by how long they waited. `answering` the rows whose
// answer is on its way, until the backend drops them; `failed` why an answer didn't take.
export type InboxState = {
  readonly items: readonly InboxRow[]
  readonly answering: Readonly<Record<string, true>>
  readonly failed: Readonly<Record<string, string>>
}

export const emptyInbox: InboxState = { items: [], answering: {}, failed: {} }

// A finish the person has read: the terminal, and the session context
// (`${projectId}/${workspaceSessionId}`) that holds it.
export type InboxFinish = { readonly context: string; readonly terminalId: string }

// A finished turn the backend stored as its own row, completed or failed, until the person
// reads it: a completed one only marks its tab unread, a failed one is a Trouble row. `reply` is the start of the agent's reply;
// `error` a failed turn's error; null where the harness gave none. `at` is the end's
// `lastTurn.at`: with `terminalId` it tells this end from any other.
export type InboxTurn = {
  readonly id: string
  readonly projectId: string
  readonly workspaceSessionId: string
  readonly terminalId: string
  readonly handle: string
  readonly agent: AgentName
  readonly at: number
  readonly outcome: "completed" | "failed"
  readonly reply: string | null
  readonly error: string | null
  readonly files: readonly string[]
}

// Where a backend that builds its Inbox from the app's own state gets it: the workspace.
export type InboxBinding = {
  readonly workspace: Store<Workspace>
}

export type Inbox = {
  readonly state: Store<InboxState>
  // Optional. Hands the Inbox the app's state to build its rows from, until the returned
  // function stops it. Absent where the backend has all it needs of its own.
  readonly bind?: (binding: InboxBinding) => () => void
  // Answers a row. The backend removes it once the answer took, or says why it didn't.
  readonly answer: (id: string, answer: InboxAnswer) => void
  // Marks a row opened.
  readonly see: (id: string) => void
  // Reads every update, leaving everything that waits on the person.
  readonly readAll: () => void
  // Optional. Dismisses an agent's open ask without answering it: it stays, settled, and its
  // agent is told. Absent where asks can't be dismissed.
  readonly dismiss?: (id: string) => void
  // Optional. Removes these settled asks.
  readonly clear?: (ids: readonly string[]) => void
  // The stored finished turns, newest last as the backend lists them, undefined until the
  // backend first lists them (and again where it stops). Includes the rows the Inbox hides
  // under a running lead, and none the person already read. Absent where the backend
  // stores none.
  readonly turns?: Store<readonly InboxTurn[] | undefined>
  // Reads every stored turn row of these terminals, as the person looks at them. The rows
  // leave `turns` at once.
  readonly readFinishes?: (finishes: readonly InboxFinish[]) => void
}

// How urgent a row is, most urgent first: trouble that stopped the agent, then
// anything else that stopped it (a limit that waits for the person among them), then what
// asks while the agent works on, then trouble that handles itself (a limit Novadeck
// resumes from) or that only holds its messages (whose own question, if any, comes first),
// then updates, and with
// them a failed turn that is no longer the agent's current end (not `stopped`), which only
// informs.
export const urgency = (row: InboxRow): number => {
  const type = inboxType(row)
  if (type === "update") return 4
  if (row.kind === "trouble" && row.trouble.type === "waits") return 3
  if (type === "trouble") {
    if (!row.stopped) return row.kind === "trouble" && row.trouble.type === "failed" ? 4 : 3
    return row.kind === "trouble" && row.trouble.type === "limit" ? 1 : 0
  }
  return row.stopped ? 1 : 2
}

// The Inbox's order: by urgency, then the longest waiting first; settled asks after all of it.
export const ordered = (rows: readonly InboxRow[]): InboxRow[] =>
  rows.toSorted((a, b) => {
    // Settled asks come last, the latest settled first.
    if (a.settled || b.settled)
      return a.settled && b.settled ? b.settled.at - a.settled.at : a.settled ? 1 : -1
    return urgency(a) - urgency(b) || a.at - b.at
  })

// The row an entry in a terminal's messages waits in: the one it came from, by id, as the
// runner lists an entry as `m-` and its row's id without dashes.
export const entryRow = (
  rows: readonly InboxRow[],
  entry: { readonly id: string },
): InboxRow | undefined =>
  rows.find((row) => row.id === entry.id || `m-${row.id.replaceAll("-", "")}` === entry.id)

// The Inbox of a backend that has none: it lists nothing, and has nothing to answer.
export const noInbox: Inbox = {
  state: createStore(emptyInbox),
  answer: () => {},
  see: () => {},
  readAll: () => {},
}

// The terminal a check of the rows is about: its full address.
export type TerminalAt = {
  readonly projectId: string
  readonly workspaceSessionId: string
  readonly terminalId: string
}

export const atTerminal = (row: InboxRow, at: TerminalAt): boolean =>
  row.source.projectId === at.projectId &&
  row.source.workspaceSessionId === at.workspaceSessionId &&
  row.source.terminalId === at.terminalId

// What a terminal needs of the person, for its tab's mark: "unblock" for any Unblock row
// or a limit past its reset that Novadeck won't resume from; otherwise "ask" for any Ask;
// otherwise nothing. Trouble, updates and settled asks don't count. Takes every row, as the backend
// lists them: the landing rule hides rows from the Inbox, never from the marks.
export const terminalNeed = (
  rows: readonly InboxRow[],
  at: TerminalAt,
  now: number,
): "unblock" | "ask" | undefined => {
  const mine = rows.filter((row) => atTerminal(row, at) && !row.settled)
  const limitReset = (row: InboxRow): boolean =>
    row.kind === "trouble" &&
    row.trouble.type === "limit" &&
    row.trouble.resetsAt <= now &&
    row.trouble.autoResume !== true
  if (mine.some((row) => inboxType(row) === "unblock" || limitReset(row))) return "unblock"
  return mine.some((row) => inboxType(row) === "ask") ? "ask" : undefined
}

// When the next usage limit among `rows` that is still ahead of `now` resets, which turns
// its terminal into an Unblock where auto-resume is off (see `terminalNeed`); undefined when none.
export const nextLimitReset = (rows: readonly InboxRow[], now: number): number | undefined =>
  rows.reduce<number | undefined>(
    (soonest, row) =>
      row.kind === "trouble" &&
      row.trouble.type === "limit" &&
      row.trouble.resetsAt > now &&
      (soonest === undefined || row.trouble.resetsAt < soonest)
        ? row.trouble.resetsAt
        : soonest,
    undefined,
  )

// Whether the terminal has a `done` report the person hasn't seen.
export const terminalDone = (rows: readonly InboxRow[], at: TerminalAt): boolean =>
  rows.some(
    (row) =>
      atTerminal(row, at) && !row.seen && row.kind === "update" && row.update.type === "done",
  )
