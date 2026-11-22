import type { ChatAnswer, ChatRequest } from "./conversation"
import type { AgentName } from "./harnesses"
import type { MessageWaits } from "./messages"
import { createStore, type Store } from "./store"
import type { TerminalKey, Workspace } from "./types"

// The Inbox: everything across the workspace that an agent, or Novadeck about an agent,
// puts in front of the person, each as its own entry. The person reads and answers it
// there, without going to the terminal. An entry is open while it waits for them, and resolved
// once it ended: it stays then, with how it ended (`Settled`), as the Inbox's history. Only an
// ask its own agent withdrew leaves it. Each entry comes from one of five sources, and the UI
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

// Where an entry comes from: the terminal, its project and session, the agent running in
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

// A held message: the thread's two terminals, by their handles as they read and title, the message, and why the
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

// A line of the agent's tool calls as Novadeck read them, and how many times in an entry it
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
      // milliseconds; and the models it covers, where not all of them ("Fable").
      readonly minutes: number
      readonly resetsAt: number
      readonly scope?: string
      // Whether Novadeck continues the agent at the reset; null where it can't, and the
      // sheet offers no switch.
      readonly autoResume: boolean | null
      readonly evidence: readonly EvidenceLine[]
    }
  // `stored` where it is a stored turn entry (read by id), not a state derived from the
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

// How an entry ended, and when. An agent's ask was `answered` (here, with its `answer`),
// `dismissed` by the person, or `replied` to by them writing in the terminal; a request the
// harness shows was `answered` (here or in the chat, with its `answer` where it is known), or
// `terminal` (answered in the terminal), or went `gone` closed in the terminal (a No or Escape, which look alike); a held message was `released` or `stopped`; trouble ended as the agent
// `worked` again, or messages waiting were `delivered`; a tell, a done report or a failed turn
// was `read`; and any entry `ended` with its agent session or its terminal, or `away` while the
// app was closed. `gone` is a dialog or waiting messages that closed with nothing to say how.
export type SettledHow =
  | "answered"
  | "terminal"
  | "dismissed"
  | "replied"
  | "released"
  | "stopped"
  | "worked"
  | "delivered"
  | "read"
  | "gone"
  | "ended"
  | "away"
export type Settled = {
  readonly how: SettledHow
  readonly at: number
  // What the person answered with, as a line, where they did.
  readonly answer?: string | undefined
}

// One entry. `at` is when it started waiting, in epoch milliseconds. `stopped` whether the
// agent waits on the person (a gate, an ask after which it ended its turn, a stuck or
// failed agent) rather than working on. `seen` once the person opened it. `settled` only on a
// entry that is resolved (see `Settled`): it asks nothing, and shows as history.
export type InboxEntry = InboxContent & {
  readonly id: string
  readonly source: InboxSource
  readonly at: number
  readonly stopped: boolean
  readonly seen: boolean
  readonly settled?: Settled
  // Set aside by the person until they bring it back: it keeps its place, and asks nothing
  // of them meanwhile. Only on an open entry that asks, where the backend keeps snoozes.
  readonly snoozed?: true
  // Held back by the landing rule: a new ask of the terminal the person is looking at, kept out
  // of what counts (the bell, the app icon, the tab and window marks) until its agent has
  // written its words in that terminal. It stays in the list. Set only on the landed Inbox's
  // copy of the entry, never by a backend.
  readonly heldBack?: true
}

// The four ways the Inbox presents an entry: Unblock (the agent can't go on without the
// person's yes or action), Ask (a question), Trouble and Update.
export type InboxType = "unblock" | "ask" | "trouble" | "update"

export const inboxType = (entry: InboxContent): InboxType => {
  if (entry.kind === "request") return entry.request.kind === "question" ? "ask" : "unblock"
  if (entry.kind === "held") return "unblock"
  if (entry.kind === "ask" && entry.ask.shape.type === "action") return "unblock"
  return entry.kind
}

// The person's answer to an entry, by its source: a dialog's answer as the chat sends it;
// a held thread released or stopped; an ask's option and/or words, or its
// action done; a stuck agent nudged with these words or stopped, auto-resume at a limit
// turned on or off, or the agent continued once the limit has reset; an update read, which
// opening it in the Inbox does.
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
    }
  | { readonly kind: "update"; readonly action: "read" }

// Every entry, the newest first (`ordered`). `answering` the entries whose
// answer is on its way, until the backend drops them; `failed` why an answer didn't take.
export type InboxState = {
  readonly items: readonly InboxEntry[]
  readonly answering: Readonly<Record<string, true>>
  readonly failed: Readonly<Record<string, string>>
}

export const emptyInbox: InboxState = { items: [], answering: {}, failed: {} }

// A finish the person has read: the terminal, and the session context
// (`${projectId}/${workspaceSessionId}`) that holds it.
export type InboxFinish = { readonly context: string; readonly terminalId: string }

// A finished turn the backend stored as its own entry, completed or failed, until the person
// reads it: a completed one only marks its tab unread, a failed one is a Trouble entry. `reply` is the start of the agent's reply;
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
  // Optional. Hands the Inbox the app's state to build its entries from, until the returned
  // function stops it. Absent where the backend has all it needs of its own.
  readonly bind?: (binding: InboxBinding) => () => void
  // Answers an entry. The backend removes it once the answer took, or says why it didn't.
  readonly answer: (id: string, answer: InboxAnswer) => void
  // Marks an entry opened.
  readonly see: (id: string) => void
  // Optional. Dismisses an agent's open ask without answering it: it stays, resolved, and its
  // agent is told. Absent where asks can't be dismissed.
  readonly dismiss?: (id: string) => void
  // Optional. The entries that ask, by `entryKey`, in the order the person dragged them into, and
  // how that order is kept, which forgets entries no longer listed; empty until they drag one.
  // Absent where the backend keeps none, and the entries keep the Inbox's own order.
  readonly order?: Store<readonly string[]>
  readonly arrange?: (keys: readonly string[]) => void
  // Optional. Snoozes an entry, or brings it back (`on` false); its entry then carries `snoozed`.
  // Absent where the backend keeps no snoozes.
  readonly snooze?: (id: string, on: boolean) => void
  // The stored finished turns, newest last as the backend lists them, undefined until the
  // backend first lists them (and again where it stops). Includes the entries the Inbox hides
  // under a running lead, and none the person already read. Absent where the backend
  // stores none.
  readonly turns?: Store<readonly InboxTurn[] | undefined>
  // Reads every stored turn entry of these terminals, as the person looks at them. The entries
  // leave `turns` at once.
  readonly readFinishes?: (finishes: readonly InboxFinish[]) => void
}

// How many resolved entries the Inbox lists: the latest to resolve, across all of it. The
// runner keeps its own history longer, for the Messages pane.
export const maxResolved = 10

// The Inbox's order: the entry added last first, open and resolved entries together; of the
// resolved ones only the `maxResolved` that resolved last.
export const ordered = (entries: readonly InboxEntry[]): InboxEntry[] => {
  const resolved = new Set(
    entries
      .filter((entry) => entry.settled)
      .toSorted((a, b) => b.settled!.at - a.settled!.at)
      .slice(0, maxResolved),
  )
  return entries
    .filter((entry) => !entry.settled || resolved.has(entry))
    .toSorted((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// The Inbox entry a message in a terminal's messages came from, by id, as the runner lists a
// message as `m-` and its Inbox entry's id without dashes.
export const inboxEntryOf = (
  entries: readonly InboxEntry[],
  message: { readonly id: string },
): InboxEntry | undefined =>
  entries.find(
    (entry) => entry.id === message.id || `m-${entry.id.replaceAll("-", "")}` === message.id,
  )

// How many snoozes are kept, the latest: as many as the runner keeps (`maxInboxOrder`, which
// the runner adapter's tests hold it to).
export const maxSnoozes = 200

// An entry by its id and when it began, as the person's order and snoozes keep it: a newer entry
// under the same id, as a thread held again or a harness asking the same again, is another.
export const entryKey = (entry: InboxEntry): string => `${entry.id}@${entry.at}`

// `inbox` with snoozes: its entries that the person snoozed, and that haven't settled, carry
// `snoozed`. `initial` the snoozes kept before, and `save` keeps them each time one is
// snoozed or brought back, the latest `maxSnoozes`.
export const withSnoozes = <I extends Inbox>(
  inbox: I,
  initial: readonly string[],
  save: (keys: readonly string[]) => void,
): I => {
  let snoozed: readonly string[] = initial.slice(-maxSnoozes)
  let keys: ReadonlySet<string> = new Set(snoozed)
  let from: InboxState | undefined
  let marked: InboxState = emptyInbox
  // Each entry's snoozed copy, while the backend keeps the entry itself, so it stays the same.
  let copies = new WeakMap<InboxEntry, InboxEntry>()
  const listeners = new Set<() => void>()
  const asleep = (entry: InboxEntry): boolean => !entry.settled && keys.has(entryKey(entry))
  const copy = (entry: InboxEntry): InboxEntry => {
    const made = copies.get(entry) ?? { ...entry, snoozed: true as const }
    copies.set(entry, made)
    return made
  }
  const mark = (state: InboxState): InboxState =>
    state.items.some(asleep)
      ? { ...state, items: state.items.map((entry) => (asleep(entry) ? copy(entry) : entry)) }
      : state
  const getSnapshot = (): InboxState => {
    const now = inbox.state.getSnapshot()
    if (now !== from) {
      from = now
      marked = mark(now)
    }
    return marked
  }
  return {
    ...inbox,
    state: {
      getSnapshot,
      subscribe: (listener) => {
        // Its own, so one function subscribed twice is told twice, and each stops alone.
        const own = (): void => listener()
        listeners.add(own)
        const stop = inbox.state.subscribe(own)
        return () => {
          listeners.delete(own)
          stop()
        }
      },
    },
    snooze: (id, on) => {
      const entry = inbox.state.getSnapshot().items.find((each) => each.id === id)
      if (on && !entry) return
      const kept = snoozed.filter((key) => !key.startsWith(`${id}@`))
      snoozed = (on && entry ? [...kept, entryKey(entry)] : kept).slice(-maxSnoozes)
      keys = new Set(snoozed)
      from = undefined
      copies = new WeakMap()
      save(snoozed)
      for (const listener of listeners) listener()
    },
  }
}

// The Inbox of a backend that has none: it lists nothing, and has nothing to answer.
export const noInbox: Inbox = {
  state: createStore(emptyInbox),
  answer: () => {},
  see: () => {},
}

export const atTerminal = (entry: InboxEntry, at: TerminalKey): boolean =>
  entry.source.projectId === at.projectId &&
  entry.source.workspaceSessionId === at.workspaceSessionId &&
  entry.source.terminalId === at.terminalId

// What a terminal needs of the person, for its tab's mark: "unblock" for any Unblock entry
// or a limit past its reset that Novadeck won't resume from; otherwise "ask" for any Ask;
// otherwise nothing. Trouble, updates, resolved entries, what the person snoozed and an ask the
// landing rule still holds back (`heldBack`) don't count. Takes the landed Inbox's entries.
export const terminalNeed = (
  entries: readonly InboxEntry[],
  at: TerminalKey,
  now: number,
): "unblock" | "ask" | undefined => {
  const mine = entries.filter(
    (entry) => atTerminal(entry, at) && !entry.settled && !entry.snoozed && !entry.heldBack,
  )
  const limitReset = (entry: InboxEntry): boolean =>
    entry.kind === "trouble" &&
    entry.trouble.type === "limit" &&
    entry.trouble.resetsAt <= now &&
    entry.trouble.autoResume !== true
  if (mine.some((entry) => inboxType(entry) === "unblock" || limitReset(entry))) return "unblock"
  return mine.some((entry) => inboxType(entry) === "ask") ? "ask" : undefined
}

// When the next usage limit among `entries` that is still ahead of `now` resets, which turns
// its terminal into an Unblock where auto-resume is off (see `terminalNeed`); undefined when none.
export const nextLimitReset = (entries: readonly InboxEntry[], now: number): number | undefined =>
  entries.reduce<number | undefined>(
    (soonest, entry) =>
      entry.kind === "trouble" &&
      entry.trouble.type === "limit" &&
      entry.trouble.resetsAt > now &&
      (soonest === undefined || entry.trouble.resetsAt < soonest)
        ? entry.trouble.resetsAt
        : soonest,
    undefined,
  )

// Whether the terminal has a `done` report the person hasn't seen.
export const terminalDone = (entries: readonly InboxEntry[], at: TerminalKey): boolean =>
  entries.some(
    (entry) =>
      atTerminal(entry, at) &&
      !entry.seen &&
      !entry.settled &&
      entry.kind === "update" &&
      entry.update.type === "done",
  )
