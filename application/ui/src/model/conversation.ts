import type { Store } from "./store"

// The conversation of the agent a terminal runs, as the agent's own records tell it: its
// transcript (Claude Code's session JSONL, Codex's rollout, Antigravity's steps), read as
// the agent writes it, never through a second agent process. A terminal's chat view
// renders it in place of the terminal's screen; the agent's TUI keeps running beneath,
// and what the person sends from the chat is typed into it.

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

// A terminal's conversation now. `agent` and `session` name the agent's session bound to
// the terminal whose transcript is read, its harness's name for the agent (`claude`,
// `codex`, `agy`); both null while none is. `loaded` once the session's records so far
// have started arriving. `items` are its root agent's, oldest first; subagents keep their
// own. `requests` wait on the person, oldest first.
export type Conversation = {
  readonly agent: string | null
  readonly session: string | null
  readonly loaded: boolean
  readonly items: readonly ChatItem[]
  readonly requests: readonly ChatRequest[]
}

export const noConversation: Conversation = {
  agent: null,
  session: null,
  loaded: false,
  items: [],
  requests: [],
}

// A terminal by its full address: ids repeat across sessions and projects in some
// backends, so a conversation is asked for by where its terminal is.
export type ConversationKey = {
  readonly projectId: string
  readonly workspaceSessionId: string
  readonly terminalId: string
}

// Where a backend's conversations come from, and how the chat talks back to the agent.
export type Conversations = {
  // The conversation of the agent in a terminal, following the terminal from session to
  // session: the same store for the same terminal while anyone subscribes. Reading starts
  // with its first subscriber and stops once its last leaves.
  readonly conversation: (key: ConversationKey) => Store<Conversation>
  // Gives the terminal's agent a prompt as the person would type it into its box, then
  // Enter. Rejects with an Error whose message tells the person why it didn't go.
  readonly send: (key: ConversationKey, text: string) => Promise<void>
  // Stops the agent's turn, as Escape in its TUI does. Resolves with the words the person
  // had queued behind the turn, which the agent gave back and the chat's box takes again,
  // or null. Rejects as `send` does.
  readonly interrupt: (key: ConversationKey) => Promise<string | null>
  // Answers a request through its dialog in the agent's TUI, as the person would with its
  // keys, resolving once it took. Rejects as `send` does; a dialog that can't be answered
  // safely turns `raw`, for the person to answer in the terminal.
  readonly answer: (key: ConversationKey, request: string, answer: ChatAnswer) => Promise<void>
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
