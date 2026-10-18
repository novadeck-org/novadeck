import type { Conversations } from "#core/conversation"
import type { TerminalKey } from "#core/port"
import type { AgentTurnEnd, AgentUsage, TerminalMetadata } from "#core/types"

// The demo's agents have one owner, `demoTurns`: each terminal's agent status, the
// requests its conversation holds and what its screen shows all follow from it, as the
// runner's do from its agents. These are its verbs, for the debug panel and the demo's
// seeds; a prompt, an answer or a Stop from the chat or the screen drives the same agent.

export type DemoAsk = "permission" | "question" | "plan"

// What work its ended turn leaves running, counted or not (both zero).
export type DemoBackground = { readonly agents: number; readonly tasks: number }

export type DemoAgentVerbs = {
  // Starts a turn that works until another verb ends it: in plan mode, or with three
  // subagents running. A terminal that runs no agent becomes Claude Code first.
  readonly work: (
    key: TerminalKey,
    terminal: TerminalMetadata | undefined,
    how?: { readonly planning?: true; readonly subagents?: true },
  ) => void
  // Stops the agent's turn on `count` requests of `kind`, each answerable from the chat
  // and the screen; a plan in plan mode. `headline` is murmur's, for a question or a plan.
  readonly ask: (
    key: TerminalKey,
    terminal: TerminalMetadata | undefined,
    kind: DemoAsk,
    count: number,
    headline?: string,
  ) => void
  // Works, if not already, and ends the turn `after` ms later the way asked, with its
  // reply, murmur's `gist` of it where given, and what it leaves running, where given.
  readonly finish: (
    key: TerminalKey,
    terminal: TerminalMetadata | undefined,
    outcome: AgentTurnEnd["outcome"],
    options?: {
      readonly after?: number
      readonly gist?: { readonly text: string; readonly asks?: true }
      readonly background?: DemoBackground
    },
  ) => void
  // Back at its prompt with no turn behind it: nothing works, waits or reads unread.
  readonly rest: (key: TerminalKey, terminal: TerminalMetadata | undefined) => void
  // Sets the agent's context and limits in the telemetry: its status stays as it was, a
  // turn or request included, and later turns keep them. A terminal that runs no agent
  // becomes Claude Code first.
  readonly usage: (
    key: TerminalKey,
    terminal: TerminalMetadata | undefined,
    usage: AgentUsage,
  ) => void
  // Lets the terminal go, saying nothing of it: what its agent had pending is called off
  // and its usage forgotten, as before the panel sets its state some other way (an exit, a
  // shell, a fixture).
  readonly release: (key: TerminalKey) => void
}

// What a demo terminal's screen reads of its agent: its conversation, as the chat reads
// it, and how many of its items it opened with, which the screen's intro stands for; the
// screen shows those after, and answers and prompts through `conversations` as the chat
// does.
export type DemoAgentLink = {
  readonly conversations: Conversations
  readonly opening: (key: TerminalKey) => number
}
