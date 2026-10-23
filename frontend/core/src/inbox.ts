import type { ChatAnswer, ChatRequest } from "./conversation"
import type { AgentName } from "./harnesses"
import type { MailWaits } from "./messages"
import { createStore, type Store } from "./store"
import type { Workspace } from "./types"

// The Inbox: everything across the workspace that an agent, or Novadeck about an agent,
// puts in front of the person, one item per terminal. The person reads and answers it
// there, without going to the terminal. Each item is one of five sources, and the UI
// presents it as one of four types:
// - `request`: a prompt the agent's harness shows and Novadeck reads from its screen
//   (`ChatRequest`, as the chat view has it). A permission or plan is an Approve, a
//   question an Ask; a dialog Novadeck can't read (`raw`) is answered in the terminal.
// - `held`: a message between two agents that Novadeck holds until the person releases
//   it, as its thread went back and forth as often as it may (an Approve).
// - `ask`: what the agent asked through Novadeck's MCP `ask` tool (an Ask).
// - `trouble`: what Novadeck noticed about the agent: stuck, at a usage limit, failed, or
//   its messages held long behind what keeps the doorbell from waking it.
// - `update`: a finished turn, or what the agent told through the MCP `tell` tool.
// Agents write subjects, bodies and options; Novadeck shows them as they are.

// Where an item comes from: the terminal, its project and session, the agent running in
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

// A held message: the thread's two terminals, by handle and title, the message, and its
// place in the thread against what the thread allows before it waits for the person.
export type HeldMessage = {
  readonly threadId: string
  readonly from: { readonly handle: string; readonly title: string }
  readonly to: { readonly handle: string; readonly title: string }
  readonly text: string
  readonly hop: number
  readonly allowed: number
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
  | { readonly type: "failed"; readonly error: string | null }
  | { readonly type: "waits"; readonly waits: MailWaits | null; readonly count: number }

// A finished turn, with the start of the agent's last reply (or murmur's gist of it) and
// the files its edit tools wrote in the turn; or something the agent told the person.
export type Update =
  | {
      readonly type: "finished"
      readonly subject: string
      readonly reply: string
      readonly files: readonly string[]
    }
  | { readonly type: "told"; readonly subject: string; readonly body: string }

export type InboxContent =
  | { readonly kind: "request"; readonly request: ChatRequest }
  | { readonly kind: "held"; readonly held: HeldMessage }
  | { readonly kind: "ask"; readonly ask: AgentAsk }
  | { readonly kind: "trouble"; readonly trouble: Trouble }
  | { readonly kind: "update"; readonly update: Update }

// One item. `at` is when it started waiting, in epoch milliseconds. `stopped` whether the
// agent waits on the person (a gate, an ask after which it ended its turn, a stuck or
// failed agent) rather than working on. `seen` once the person opened it.
export type InboxItem = InboxContent & {
  readonly id: string
  readonly source: InboxSource
  readonly at: number
  readonly stopped: boolean
  readonly seen: boolean
}

// The four ways the Inbox presents an item.
export type InboxType = "approve" | "ask" | "trouble" | "update"

export const inboxType = (item: InboxContent): InboxType => {
  if (item.kind === "request") return item.request.kind === "question" ? "ask" : "approve"
  if (item.kind === "held") return "approve"
  return item.kind
}

// The person's answer to an item, by its source: a dialog's answer as the chat sends it;
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
        | { readonly type: "nudge"; readonly text: string }
        | { readonly type: "stop" }
        // A limit that has reset: sends `continue` as the agent's next prompt, with no interrupt.
        | { readonly type: "continue" }
        | { readonly type: "auto-resume"; readonly on: boolean }
    }
  | { readonly kind: "update"; readonly action: "read" }

// Every item, waiting ones first by how long they waited. `answering` the items whose
// answer is on its way, until the backend drops them; `failed` why an answer didn't take.
export type InboxState = {
  readonly items: readonly InboxItem[]
  readonly answering: Readonly<Record<string, true>>
  readonly failed: Readonly<Record<string, string>>
}

export const emptyInbox: InboxState = { items: [], answering: {}, failed: {} }

// A finish the person has read: the terminal, and the session context
// (`${projectId}/${workspaceSessionId}`) that holds it.
export type InboxFinish = { readonly context: string; readonly terminalId: string }

// Where a backend that builds its Inbox from the app's own state gets it: the workspace,
// the terminals whose agent finished while the person looked elsewhere (by session context,
// then terminal id, as `Unread` has them), and a way to read finishes.
export type InboxUnread = Readonly<Record<string, Readonly<Record<string, "done" | "failed">>>>
export type InboxBinding = {
  readonly workspace: Store<Workspace>
  readonly unread: Store<InboxUnread>
  readonly read: (finishes: readonly InboxFinish[]) => void
}

export type Inbox = {
  readonly state: Store<InboxState>
  // Optional. Hands the Inbox the app's state to build its items from, until the returned
  // function stops it. Absent where the backend has all it needs of its own.
  readonly bind?: (binding: InboxBinding) => () => void
  // Answers an item. The backend removes it once the answer took, or says why it didn't.
  readonly answer: (id: string, answer: InboxAnswer) => void
  // Marks an item opened.
  readonly see: (id: string) => void
  // Reads every update, leaving everything that waits on the person.
  readonly readAll: () => void
}

// How urgent an item is, most urgent first: trouble that stopped the agent, then
// anything else that stopped it (a limit that waits for the person among them), then what
// asks while the agent works on, then trouble that handles itself (a limit Novadeck
// resumes from) or that only holds its messages (whose own question, if any, comes first),
// then updates.
export const urgency = (item: InboxItem): number => {
  const type = inboxType(item)
  if (type === "update") return 4
  if (item.kind === "trouble" && item.trouble.type === "waits") return 3
  if (type === "trouble") {
    if (!item.stopped) return 3
    return item.kind === "trouble" && item.trouble.type === "limit" ? 1 : 0
  }
  return item.stopped ? 1 : 2
}

// The Inbox's order: by urgency, then the longest waiting first.
export const ordered = (items: readonly InboxItem[]): InboxItem[] =>
  items.toSorted((a, b) => urgency(a) - urgency(b) || a.at - b.at)

// The Inbox of a backend that has none: it lists nothing, and has nothing to answer.
// The item a letter in a terminal's messages waits in: the one it came from, by id, as the
// runner lists a letter as `m-` and its item's id without dashes; else, as one row a
// terminal shows its most urgent item, the item its terminal shows.
export const letterItem = (
  items: readonly InboxItem[],
  letter: { readonly id: string },
  terminalId: string,
): InboxItem | undefined =>
  items.find((item) => item.id === letter.id || `m-${item.id.replaceAll("-", "")}` === letter.id) ??
  items.find((item) => item.source.terminalId === terminalId)

export const noInbox: Inbox = {
  state: createStore(emptyInbox),
  answer: () => {},
  see: () => {},
  readAll: () => {},
}
