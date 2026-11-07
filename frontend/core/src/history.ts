import type { AgentName } from "./harnesses"
import type { Store } from "./store"

// History: the terminals closed in the last 30 days, per project, to restore. A backend that
// keeps them reports every row (`state`) and reads a project's rows afresh when the pane
// opens (`list`); it restores one when `newTerminal` is given its id as `closed`.

// Whether a closed terminal can be restored now. `gone` says what is missing, the
// conversation or the folder it ran in; `disconnected` names the agent whose harness is not
// connected; `open` gives the handle of the terminal the conversation is bound in.
export type ClosedTerminalState =
  | { readonly state: "ready" }
  | { readonly state: "restoring" }
  | { readonly state: "gone"; readonly reason: "conversation" | "folder" }
  | { readonly state: "disconnected"; readonly agent: AgentName }
  | { readonly state: "open"; readonly handle: string }

export type ClosedTerminal = {
  // The id the terminal had.
  readonly id: string
  readonly projectId: string
  readonly title: string
  readonly summary: string | null
  readonly handle: string | null
  // The program's icon; null for a plain terminal, whose last `program` stands in for it.
  readonly agent: AgentName | null
  readonly program: string | null
  readonly cwd: string
  // When it closed, in milliseconds since the epoch.
  readonly closedAt: number
  // The handle of the agent that closed it; null when the person did.
  readonly closedBy: string | null
  readonly availability: ClosedTerminalState
}

export type HistoryState = {
  // Every project's rows, newest first.
  readonly rows: readonly ClosedTerminal[]
}

export type History = {
  readonly state: Store<HistoryState>
  // A project's rows as they are now, with their availability checked, newest first; the
  // state takes them too. Rejects when the backend cannot say.
  readonly list: (projectId: string) => Promise<readonly ClosedTerminal[]>
}
