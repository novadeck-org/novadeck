import type { Refused } from "./conversation/prompt-refusal"
import type { Store } from "./store"
import type { TerminalKey } from "./types"

// The conversation of the agent a terminal runs, as the agent's own records tell it: its
// transcript (Claude Code's session JSONL, Codex's rollout, Antigravity's steps), read as
// the agent writes it, never through a second agent process. A terminal's chat view
// renders it in place of the terminal's screen; the agent's TUI keeps running beneath,
// and what the person sends from the chat is typed into it.

// What a tool call was, as its harness's decoder said: the chat's one line for it. The same
// shape as the protocol's `toolRun`, declared here since the core reads no more of the
// protocol than its data entries (a test holds the two to each other).
export type ToolKind = "run" | "read" | "write" | "search" | "web" | "agent" | "plan" | "other"
export type ToolRun = {
  readonly kind: ToolKind
  // What the tool is called to a person: "Ran", "Read", "Edited".
  readonly title: string
  // What it was called on: the command, the file, the pattern. Empty where there is none.
  readonly detail: string
}

// One record of the conversation, in the order its harness wrote it: the person's or the
// agent's text, another agent's message to it (`author` names that agent, in its
// harness's words), a tool call with its input as text (often JSON), or a tool's result,
// which `call` pairs with its call; a result may come before its call. Text past what the
// backend carries is cut short and marked `truncated`. Private reasoning is never there.
export type ChatItem = {
  // Stable for the item while its session lasts, so a list can key by it.
  readonly id: string
  // Epoch milliseconds, where the harness recorded when.
  readonly at: number | null
  readonly role: "user" | "assistant" | "agent" | "tool"
  readonly kind: "text" | "tool-call" | "tool-result"
  readonly text: string
  readonly truncated: boolean
  // The tool's name, in the harness's words, on a call.
  readonly tool: string | null
  // What pairs a result with its call: the same on both, null where the harness says none.
  readonly call: string | null
  readonly author: string | null
  // On a call, what it was; null on every other item.
  readonly run: ToolRun | null
  // A user item that records the person stopping the agent.
  readonly interrupted: boolean
}

// What a request's dialog in the agent's TUI offers, as the backend read it, so the chat
// can answer it (`Conversations.answer`):
// - `choices`: options to pick one of (a permission, a plan approval). An option with
//   `text` takes the person's words: typed into the dialog's own field (`field`), or sent
//   as the agent's next prompt once it's chosen (`prompt`).
// - `questions`: one or more questions, each with its options, whether several may be
//   picked, and whether the person may answer in their own words.
// - `form`: a form an MCP server asks the person to fill: its message and fields (text, a
//   number, yes or no, or one of a set of choices), accepted with values or declined.
// - `raw`: a dialog is up, but it can't be answered from the chat: the backend doesn't
//   recognise it (as after an agent update changed it), the agent offers no way to
//   (`unsupported`), or an answer didn't take (`failed`). `text` is what the terminal
//   shows of it, to read; the person answers in the terminal.
// A readable dialog has an `id`, which an answer names: the backend refuses an answer to
// a dialog that no longer reads the same, pressing nothing. `detail` is what the dialog
// shows of what it asks about (the command, the tool's arguments), to read before
// answering.
export type ChatDialogOption = {
  readonly id: string
  readonly label: string
  readonly text: "field" | "prompt" | null
}
export type ChatQuestion = {
  readonly id: string
  readonly header: string | null
  readonly question: string
  readonly options: readonly {
    readonly id: string
    readonly label: string
    readonly description: string | null
  }[]
  readonly multiSelect: boolean
  readonly text: boolean
}
export type ChatFormField = {
  readonly id: string
  readonly label: string
  readonly description: string | null
  readonly kind: "text" | "number" | "boolean" | "choice"
  readonly choices: readonly string[]
  readonly required: boolean
}
export type ChatDialog =
  | {
      readonly type: "choices"
      readonly id: string
      readonly title: string | null
      readonly detail: string | null
      readonly options: readonly ChatDialogOption[]
    }
  | {
      readonly type: "questions"
      readonly id: string
      // Whether the person may set the questions aside to talk it over first, and how
      // their words reach the agent then: typed into the dialog, or as its next prompt.
      readonly chat: "field" | "prompt" | null
      readonly questions: readonly ChatQuestion[]
    }
  | {
      readonly type: "form"
      readonly id: string
      readonly message: string
      readonly fields: readonly ChatFormField[]
    }
  | {
      readonly type: "raw"
      readonly text: string
      readonly reason: "unrecognized" | "unsupported" | "failed"
    }

// The person's answer to a dialog: an option by id, with their words where it takes them;
// an answer per question, by ids, with the options picked and/or their own words; or a
// form accepted with a value per field, by id, or declined.
export type ChatAnswer =
  | {
      readonly type: "choice"
      readonly dialog: string
      readonly option: string
      readonly text?: string
    }
  | {
      readonly type: "questions"
      readonly dialog: string
      readonly answers: readonly {
        readonly question: string
        readonly options: readonly string[]
        readonly text?: string
      }[]
    }
  | { readonly type: "chat"; readonly dialog: string; readonly text?: string }
  | {
      readonly type: "form"
      readonly dialog: string
      readonly action: "accept" | "decline"
      readonly values: Readonly<Record<string, string | number | boolean>>
    }

// A request of the agent's, or of a subagent it started, that waits on the person: a
// permission, a question or a plan to approve, what it asks about, and the answers it
// offers, where its harness tells them. `dialog` is how its dialog in the agent's TUI
// reads, once it's on screen; null before, or where the backend reads none.
export type ChatRequest = {
  readonly id: string
  readonly kind: "permission" | "question" | "plan"
  readonly tool: string
  readonly subject: string | null
  readonly choices: readonly string[]
  // Whether a subagent asks, rather than the root agent.
  readonly subagent: boolean
  readonly dialog: ChatDialog | null
  // Whether it was answered from the chat and the agent has yet to report it settled.
  readonly answered: boolean
}

// A prompt given the agent through `Conversations.send`, and whether its own record has it
// yet, as the backend reads that record (where it tells, `SendResult.tracked`): `pending`
// until it does; `settled` once it does, as the person's words of the item at `item` (its
// index in `items`), which a chat may show it as until that item arrives; `unrecorded`
// when the agent's turns went by and the record never got it; `in-box` when it didn't, and
// the words are back in the agent's own box; `withdrawn` when a Stop handed them back.
// `text` is the prompt as given, null once withdrawn, or settled before its words were seen. `sentAt` is when it went,
// on the backend's clock.
export type ChatPrompt = {
  readonly ref: string
  readonly text: string | null
  readonly sentAt: number
  readonly state: "pending" | "settled" | "unrecorded" | "in-box" | "withdrawn"
  readonly item: number | null
}

// What the agent's own input box holds on its screen, which a message sent now goes out with,
// so that nothing goes unseen: `text` as the box shows it, `mode` whether that is its shell
// mode's, `tail` where that may be only the end of it, and `known` where all of it is a prompt
// of the person's that came back there, which the next message takes out and hands back to the
// chat's box rather than sending along.
export type ChatBox = {
  readonly text: string
  readonly mode: "prompt" | "shell"
  readonly tail: boolean
  readonly known: boolean
}

// A terminal's conversation now. `agent` and `session` name the agent's session bound to
// the terminal whose transcript is read, its harness's name for the agent (`claude`,
// `codex`, `agy`); both null while none is. `loaded` once the session's records so far
// have started arriving. `items` are its root agent's, oldest first; subagents keep their
// own. `requests` wait on the person, oldest first. `prompts` are the session's prompts
// given through `send`, oldest first, as far as the backend follows them. `unread` once the
// session's records hold a part of the conversation the backend can't read, which `items`
// leave out and the terminal shows. `box` is what the agent's input box holds, null while there
// is nothing to show.
export type Conversation = {
  readonly agent: string | null
  readonly session: string | null
  readonly loaded: boolean
  readonly items: readonly ChatItem[]
  readonly requests: readonly ChatRequest[]
  readonly prompts: readonly ChatPrompt[]
  readonly unread: boolean
  readonly box: ChatBox | null
}

export const noConversation: Conversation = {
  agent: null,
  session: null,
  loaded: false,
  items: [],
  requests: [],
  prompts: [],
  unread: false,
  box: null,
}

// What `Conversations.send` resolves with, where its backend follows prompts: whether a
// receipt for it (`Conversation.prompts`, by the `ref` it was sent with) follows. A backend
// that follows none resolves with nothing. `returned`, where the message took words out of the
// agent's box to go (see `ChatBox`), are those words, for the chat's box.
export type SendResult = { readonly tracked: boolean; readonly returned?: string | null }

// Where a backend's conversations come from, and how the chat talks back to the agent.
export type Conversations = {
  // The conversation of the agent in a terminal, following the terminal from session to
  // session: the same store for the same terminal while anyone subscribes. Reading starts
  // with its first subscriber and stops once its last leaves.
  readonly conversation: (key: TerminalKey) => Store<Conversation>
  // Gives the terminal's agent a prompt as the person would type it into its box, then
  // Enter. Rejects with an Error whose message tells the person why it didn't go.
  // `automatic` marks a fixed line an Inbox button sends, not words the person wrote: the
  // agent's turn on it takes no open ask out of the Inbox. `ref` names its receipt in
  // `Conversation.prompts` (16 letters, digits, `_` or `-`; see `promptRef`), where the
  // backend follows it. `along` is the chat's own send, whose person can see what the agent's
  // box holds (`Conversation.box`): that goes out with it where it can. Without it, the box must
  // be empty.
  readonly send: (
    key: TerminalKey,
    text: string,
    options?: { readonly automatic?: true; readonly along?: true; readonly ref?: string },
  ) => Promise<SendResult | void>
  // Stops the agent's turn, as Escape in its TUI does. Resolves with the words the person
  // had queued behind the turn, which the agent gave back and the chat's box takes again,
  // or null. Rejects as `send` does.
  readonly interrupt: (key: TerminalKey) => Promise<string | null>
  // Takes what the agent's own box holds out of it for the chat's, where it can be read whole
  // and the backend has a box: the words, or null where nothing was taken, which `box` then
  // still shows.
  readonly takeBox?: (key: TerminalKey) => Promise<string | null>
  // Puts the chat's draft in the agent's own box, with no Enter, as the person goes to its
  // terminal: whether it went. Where not, the draft stays the chat's.
  readonly putBox?: (key: TerminalKey, text: string) => Promise<boolean>
  // Answers a request through its dialog in the agent's TUI, as the person would with its
  // keys, resolving once it took. Rejects as `send` does; a dialog that can't be answered
  // safely turns `raw`, for the person to answer in the terminal.
  readonly answer: (key: TerminalKey, request: string, answer: ChatAnswer) => Promise<void>
  // Whether `send`, or an answer's words that go on as a prompt, would be refused for the
  // text's shape, so the chat warns before it sends. Text that is nothing but white space
  // isn't refused here, though `send` refuses it: the chat sends no empty message, and an
  // option's words are optional, so there is nothing to warn about yet.
  readonly refused: Refused
}

// A fresh ref for a prompt's receipt, as the backend takes them.
export const promptRef = (): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => alphabet[byte % 64]).join("")
}

// What `Conversations.answer` rejects with when the answer took but the words that follow
// (sent as a prompt after an option or a chat) did not reach the agent: the request is
// answered, and what the person wrote is theirs to send again.
export class WordsLost extends Error {
  constructor() {
    super("Answered, but your words didn't reach the agent.")
    this.name = "WordsLost"
  }
}

// Why the agent couldn't take what was typed into its terminal for the person, as the
// backend says: a request waits on the person (`pending`), another agent's message is
// reaching it (`ringing`), its input box holds text that can't go along (`draft`), holds a
// command of the agent's own (`command`), is in a shell mode it can't be taken out of (`shell`)
// or isn't found on its screen (`no-box`), no agent is running there (`no-agent`), the text has
// no room in the box on this screen (`too-tall`), or the screen takes no pasted text yet
// (`no-paste`).
export type ConflictReason =
  | "pending"
  | "ringing"
  | "draft"
  | "no-agent"
  | "no-box"
  | "too-tall"
  | "shell"
  | "no-paste"
  | "command"

// What the person did that the agent couldn't take: sent a message, pressed Stop, or picked
// an option of a request.
export type ChatAction = "send" | "stop" | "answer"

// A failure the person settles in the agent's terminal, which the chat offers to show.
export class SettleInTerminal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SettleInTerminal"
  }
}

// A failure with the words the message took out of the agent's box before it failed, which the
// chat's box takes all the same: they are in the agent's no longer.
export const withReturned = <E extends Error>(failure: E, returned: string | undefined): E =>
  returned === undefined ? failure : Object.assign(failure, { returned })

// The words a failure came with (`withReturned`), if any.
export const returnedBy = (failure: unknown): string | undefined => {
  const { returned } = (failure ?? {}) as { readonly returned?: unknown }
  return typeof returned === "string" ? returned : undefined
}

// Stop took the turn's Escape, but the words queued behind it are still in the agent's box: the
// next message sees to them.
export const notCleared = (): Error =>
  new Error(
    "Stopped. Your queued message is still in the agent's box, and comes back here or goes out with your next message.",
  )

// What the person is told when the agent couldn't take what the chat typed for them, by
// why and by what they did: what clears by itself says to try that again, and what the
// person settles in the terminal says so and offers it. Without a reason the backend gave,
// the terminal is where to look.
export const conflictFailure = (reason: ConflictReason | undefined, action: ChatAction): Error => {
  const again = { send: "send again", stop: "stop it again", answer: "answer again" }[action]
  const retry = { send: "Send again", stop: "Stop it again", answer: "Try the answer again" }[
    action
  ]
  switch (reason) {
    case "pending":
      // A request's dialog takes a message's or a Stop's keys as its answer.
      return new Error(
        action === "stop"
          ? "The agent is waiting for your answer. Answer it first, then stop it."
          : "The agent is waiting for your answer. Answer it here, then send again.",
      )
    case "ringing":
      return new Error(`Another agent's message is reaching it right now. ${retry} in a moment.`)
    case "no-paste":
      return new Error(
        `The agent isn't ready for ${action === "send" ? "a message" : "that"} yet. ${retry} in a moment.`,
      )
    case "draft":
      return new SettleInTerminal(
        `The agent's input box already holds text. Clear it in the terminal, then ${again}.`,
      )
    case "shell":
      return new SettleInTerminal(
        `The agent's input box is in shell mode. Leave it in the terminal, then ${again}.`,
      )
    case "command":
      return new SettleInTerminal(
        `The agent's input box holds a command it hasn't run. Clear it in the terminal, then ${again}.`,
      )
    case "too-tall":
      return new SettleInTerminal(
        "This is too long for the agent's input box on this screen. Make the terminal larger or the message shorter.",
      )
    case "no-agent":
      return new SettleInTerminal("No agent is running in this terminal.")
    case "no-box":
      return new SettleInTerminal(
        "Novadeck can't find the agent's input box on its screen. Check the terminal.",
      )
    default:
      return new SettleInTerminal("The agent can't take that right now. Check its terminal.")
  }
}
