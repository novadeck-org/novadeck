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

// A request of the agent's, or of a subagent it started, that waits on the person: a
// permission, a question or a plan to approve, what it asks about, and the answers it
// offers, where its harness tells them. The person answers it in the agent's own TUI.
export type ChatRequest = {
  readonly id: string
  readonly kind: "permission" | "question" | "plan"
  readonly tool: string
  readonly subject: string | null
  readonly choices: readonly string[]
  // Whether a subagent asks, rather than the root agent.
  readonly subagent: boolean
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
}
