import type { InboxRow } from "@novadeck/core/inbox"

// What a sheet shows to get the person back into an agent's task: their last words to it
// and the few steps it took since. Read from the agent's transcript (`agents.transcript`),
// the same for Claude Code, Codex and Antigravity.

// One step: a tool call that edited, ran or failed, in the harness's own words.
export type AgentStep = {
  readonly kind: "edit" | "run" | "fail"
  // The tool's name as the harness gave it ("Edit", "Bash", "apply_patch").
  readonly tool: string
  // Its argument on one line: a path, a command.
  readonly arg: string
  // What came of it, where known: "+4 −2" for an edit, a short line for a run, the error.
  readonly result: string | null
}

export type AgentContext = {
  // The last words the agent was given, and who gave them: null for the person, a lead's
  // handle (bare, no @) for a teammate's handoff.
  readonly said: { readonly text: string; readonly by: string | null; readonly at: number } | null
  // At most three, oldest first.
  readonly steps: readonly AgentStep[]
}

// The agent's context for an item's sheet, read while the sheet shows it: undefined while it
// loads or where there's no transcript (a plain shell).
export const useAgentContext = (_item: InboxRow): AgentContext | undefined => undefined
