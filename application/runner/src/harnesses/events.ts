import type { AgentName, AgentTelemetry } from "@novadeck/protocol"

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
  /** The session's transcript, when the harness names it with an absolute path. */
  readonly transcript?: string
}

/**
 * What the agent in a session did, as its own hooks report it: a turn started or ended,
 * or a request started or stopped waiting on the person. A request has no id of its own
 * in any harness, so `requestId` is derived from the tool call it asks about and the
 * actor that asks: the root agent, or a subagent by its id. A result marked `loose`
 * resolves the actor's oldest request of that tool when its call changed on the way, as
 * an answered question's does.
 */
export type ActivityEvent = {
  readonly agent: AgentName
  readonly sessionId: string
  readonly instance: string | null
  readonly startedAt: number
} & (
  | { readonly type: "turn-started" }
  | { readonly type: "turn-ended"; readonly outcome: "completed" | "interrupted" | "failed" }
  | {
      readonly type: "attention-requested"
      readonly requestId: string
      readonly actor: string | null
      readonly toolName: string
      readonly kind: "permission" | "question"
    }
  | {
      readonly type: "attention-resolved"
      readonly requestId: string
      readonly actor: string | null
      readonly toolName: string
      readonly loose: boolean
      readonly outcome: "allowed"
    }
)

/**
 * What a session's own records said of its tokens and quotas, each part only when they
 * named it: how full its context is, and its rate-limit windows.
 */
export type TelemetryObserved = {
  readonly type: "telemetry-observed"
  readonly agent: AgentName
  readonly sessionId: string
  readonly instance: string | null
  readonly startedAt: number
  readonly context?: AgentTelemetry["context"]
  readonly limits?: AgentTelemetry["limits"]
}

/** A normalized fact a harness reported. */
export type HarnessEvent = SessionObserved | ActivityEvent | TelemetryObserved
