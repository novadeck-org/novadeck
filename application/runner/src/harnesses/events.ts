import type { AgentName } from "@novadeck/protocol"

import type { Report } from "../shell/reports.js"
import type { Continuity } from "./harness.js"
import { harnesses } from "./registry.js"

/**
 * A harness saw its root session running in a terminal. `evidence` says how that session
 * relates to the one the terminal had: a fresh start, a switch the harness announced
 * itself, or only that this conversation runs. `startedAt` is when the hook started, on
 * the runner's clock, so it compares with the shell's prompts.
 */
export type SessionObserved = {
  readonly type: "session-observed"
  readonly agent: AgentName
  readonly sessionId: string
  readonly evidence: Continuity
  readonly startedAt: number
  /** The harness's own directory, when it is an absolute path here. */
  readonly cwd?: string
}

/** A hook's report as a normalized event, with the harness reading its native source. */
export const observed = ({ agent, sessionId, seq, cwd, source }: Report): SessionObserved => ({
  type: "session-observed",
  agent,
  sessionId,
  evidence: harnesses[agent].continuity(source),
  startedAt: seq,
  ...(cwd !== undefined && { cwd }),
})
