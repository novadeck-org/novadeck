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
  /**
   * Whether the harness names this its root session, as Antigravity's status line does;
   * its hooks name subagents' conversations alike.
   */
  readonly root?: boolean
}

/**
 * What the agent in a session did, as its own hooks report it: a turn started or ended,
 * a request started or stopped waiting on the person, a subagent started or stopped, the
 * agent was seen planning or not, or an actor wrote or presented a plan. A turn starts
 * with a `prompt` submitted at the root (the person's, as far as anything tells), one
 * the harness started by itself (a background task's result), a later model `call` of a
 * turn already running, or NovaDeck's `doorbell`: a prompt that is exactly its line. It ends `completed` only when its harness says so (a root
 * Stop, which may leave work it started running in the `background`); `turn-idle` says
 * the agent shows idle however its turn ended, which without such a Stop was an Esc or a
 * denial. `file-touched` names a file an actor wrote or edited. A request has no id of its own
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
  | {
      readonly type: "turn-started"
      readonly cause: "prompt" | "harness" | "call" | "doorbell"
      /** The person's prompt, where the hook names it, without any doorbell line in it. */
      readonly prompt?: string
      /** A doorbell prompt's nonce. */
      readonly nonce?: string
    }
  | {
      readonly type: "turn-ended"
      readonly outcome: "completed" | "interrupted" | "failed"
      /** Whether work the turn started still runs, and may start another turn by itself. */
      readonly background?: boolean
    }
  | {
      readonly type: "turn-idle"
      /** Whether work the turn started, as a subagent, still runs. */
      readonly background: boolean
    }
  | { readonly type: "file-touched"; readonly actor: string | null; readonly path: string }
  | {
      readonly type: "attention-requested"
      readonly requestId: string
      readonly actor: string | null
      readonly toolName: string
      readonly kind: "permission" | "question" | "plan"
      /** What it asks about, and the answers it offers, where its call names them. */
      readonly subject: string | null
      readonly choices: readonly string[]
    }
  | {
      readonly type: "attention-resolved"
      readonly requestId: string
      readonly actor: string | null
      readonly toolName: string
      readonly loose: boolean
      readonly outcome: "allowed"
    }
  | {
      readonly type: "subagent-started"
      readonly actor: string
      /** What kind of subagent it is, in the harness's own words. */
      readonly actorType: string | null
    }
  | { readonly type: "subagent-stopped"; readonly actor: string }
  | { readonly type: "mode-observed"; readonly planning: boolean }
  | { readonly type: "plan-observed"; readonly actor: string | null; readonly plan: PlanSource }
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

/** Where a plan is: a file the harness wrote it to, or its text when it named no file. */
export type PlanSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "text"; readonly text: string; readonly truncated: boolean }

/** A normalized fact a harness reported. */
export type HarnessEvent = SessionObserved | ActivityEvent | TelemetryObserved
