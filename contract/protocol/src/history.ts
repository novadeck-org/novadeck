import { z } from "zod"

import { agentName } from "./agents.js"
import { directory, id } from "./fields.js"
import { handle, terminalTitle } from "./terminals.js"

/** How long a closed terminal's summary and program run at most, in UTF-16 code units. */
export const historyLimits = { summary: 4096, program: 256 } as const

// Whether a closed terminal can be restored, as the runner found when the list was read:
// `ready`; `restoring`, a restore under way; `gone`, with `reason` the conversation's file
// or the folder it ran in no longer there; `disconnected`, its `agent`'s harness not
// connected; `open`, the conversation is bound in another terminal, by that terminal's
// `handle`.
export const closedTerminalState = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("ready") }),
  z.strictObject({ state: z.literal("restoring") }),
  z.strictObject({ state: z.literal("gone"), reason: z.enum(["conversation", "folder"]) }),
  z.strictObject({ state: z.literal("disconnected"), agent: agentName }),
  z.strictObject({ state: z.literal("open"), handle }),
])

// A terminal the person or an agent closed, kept for 30 days. Its `id` is the one the
// terminal had; `agent` is the program's icon, null for a plain terminal, whose last
// `program` stands in for it; `closedBy` is the handle of the agent that closed it, null
// when the person did.
export const closedTerminal = z.strictObject({
  id,
  projectId: id,
  title: terminalTitle,
  summary: z.string().max(historyLimits.summary).nullable(),
  handle: handle.nullable(),
  agent: agentName.nullable(),
  program: z.string().max(historyLimits.program).nullable(),
  cwd: directory,
  closedAt: z.number(),
  closedBy: handle.nullable(),
  availability: closedTerminalState,
})

// `history.watch` events: every closed terminal, `synced`, then each later change.
export const historyChange = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("changed"), closed: closedTerminal }),
  z.strictObject({ type: z.literal("removed"), id, projectId: id }),
  // Follows the initial `changed` events: rows not reported by now do not exist.
  z.strictObject({ type: z.literal("synced") }),
])

export type ClosedTerminalState = z.infer<typeof closedTerminalState>
export type ClosedTerminal = z.infer<typeof closedTerminal>
export type HistoryChange = z.infer<typeof historyChange>
