import type { AgentName } from "@novadeck/protocol"

import type { Continuity } from "./harness.js"

/**
 * A harness saw its root session running in a terminal. `evidence` says how that session
 * relates to the one the terminal had: a fresh start, a switch the harness announced
 * itself, or only that this conversation runs. `startedAt` is when the hook started, on
 * the runner's clock, so it compares with the shell's prompts. `instance` is the harness
 * process that reported it, where the platform tells.
 */
export type SessionObserved = {
  readonly type: "session-observed"
  readonly agent: AgentName
  readonly sessionId: string
  readonly evidence: Continuity
  readonly startedAt: number
  readonly instance: string | null
  /** The harness's own directory, when it is an absolute path here. */
  readonly cwd?: string
}

/** A normalized fact a harness reported. */
export type HarnessEvent = SessionObserved
