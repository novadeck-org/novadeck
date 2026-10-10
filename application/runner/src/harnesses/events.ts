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
  /**
   * Whether the harness reports that it compacted the session's context, as Claude Code's
   * and Codex's SessionStart with source `compact` do.
   */
  readonly compacted?: boolean
  /**
   * Whether the harness announced this new session as its own input prompt came up, past
   * any trust, onboarding or login screen: Claude Code's SessionStart at a `startup`,
   * `clear`, `resume` or `fork`, and Antigravity's status line saying idle in it. Only
   * such a session may be rung before its first turn (see docs/agent-messaging.md,
   * "States").
   */
  readonly atPrompt?: boolean
}

/**
 * The harness shows its own empty input prompt, past any trust, update, login, hooks
 * review or picker screen, before a session it names in full has bound there: Codex's
 * terminal title saying Ready, Antigravity's status line saying idle with no conversation
 * yet. Messages wait for the first session of that agent to bind there, and the doorbell
 * may ring it (see docs/agent-messaging.md, "States"). `sessionPrefix` is the start of the
 * session's id, where the harness shows only that much of it, as Codex's title does.
 */
export type PromptShown = {
  readonly type: "prompt-shown"
  readonly agent: AgentName
  readonly instance: string | null
  readonly startedAt: number
  readonly sessionPrefix?: string
}

/**
 * What the agent in a session did, as its own hooks report it: a turn started or ended,
 * a request started or stopped waiting on the person, a subagent started, stopped or had
 * its turn aborted, the agent was seen planning or not, or an actor wrote or presented a
 * plan. A turn starts
 * with a `prompt` submitted at the root (the person's, as far as anything tells), one
 * the harness started by itself (a background task's result), a later model `call` of a
 * turn already running, or Novadeck's `doorbell`: a prompt that is exactly its line. It ends `completed` only when its harness says so (a root
 * Stop, which may leave work it started running in the `background`, or the session's
 * own records of that Stop, `recorded`, should its hook not have come); `turn-idle` says
 * the agent shows idle however its turn ended, which without such a Stop was an Esc or a
 * denial. `turn-working` says it shows working, which starts no turn: it only resumes one
 * a `turn-idle` older than it ended, never one a Stop did, and tells the subagents it runs. A request asked `midTurn`
 * waits on the person only while a turn runs, so a stale one after a Stop asks nothing.
 * `file-touched` names a file an actor wrote or edited. A request has no id of its own
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
      /** The turn's id, where the harness names one, as Codex does. */
      readonly turn?: string
    }
  | {
      readonly type: "turn-ended"
      readonly outcome: "completed" | "interrupted" | "failed"
      /**
       * What the turn left running that wakes the agent once done, where its harness says;
       * unsaid, its subagents still running count, where their end wakes it.
       */
      readonly background?: Background
      /**
       * Told by the session's own records, not a hook: Claude Code's transcript or Codex's
       * rollout, in case the hook's report never came. It ends only the turn still running,
       * its `turn` where both name one, and leaves the fence for that hook's Stop, which
       * may say more of what runs.
       */
      readonly recorded?: true
      /** The turn's id, where the records name one. */
      readonly turn?: string
      /**
       * The start of the agent's last reply in the turn, as `replyPreview` makes it, where
       * its hook, its records or its transcript tell it.
       */
      readonly reply?: string
    }
  | {
      readonly type: "turn-idle"
      /** What the turn started that still runs, as its subagents. */
      readonly background: Background
    }
  | {
      readonly type: "turn-working"
      /**
       * How many subagents the harness counts running as it says so, where it counts them
       * while the turn runs, as Antigravity's status line does: they show in `background`
       * until the turn ends.
       */
      readonly running?: number
    }
  /**
   * Novadeck continued the root turn its Stop, started at `startedAt`, would have ended,
   * delivering messages with the hook's answer: the turn goes on until the continuation's
   * own Stop, as Claude Code and Codex fire no prompt hook for it.
   */
  | { readonly type: "turn-continued" }
  /**
   * The Stop Novadeck continued, started at the turn's latest `turnAt`, was never
   * continued after all: its hook never acknowledged its messages, which wait again.
   */
  | { readonly type: "turn-lapsed" }
  /**
   * The person pressed Escape while the root turn ran, as their keys tell delivery (see
   * docs/agent-messaging.md, "States"): it may have cancelled the turn, which no hook
   * says, as Claude Code's Escape before its first reply. Started when the key came.
   */
  | { readonly type: "turn-escaped" }
  /**
   * The window the harness has to say how the turn the person's Escape ended, at
   * `startedAt`, ended has passed (`escapeVerdictMs`): a Stop it reported meanwhile is the
   * turn's end, else the Escape stands.
   */
  | { readonly type: "turn-escape-lapsed" }
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
      /**
       * The tool's input as the hook gave it (questions, a command, a plan), for the
       * harness's dialog adapter to check its dialog against; absent where none came.
       */
      readonly input?: unknown
      /** The directory the agent's hook said it ran in, where it said one. */
      readonly cwd?: string
      /**
       * Whether only the screen told it (see `DialogAdapter.screenRequest`): the terminal
       * manager raises it, and it resumes no turn.
       */
      readonly screen?: true
      /**
       * Whether only a root turn running asks it, and only a snapshot that may lag behind
       * the turn's end tells it, as Antigravity's status line shows a confirmation: it
       * counts only while a turn runs, or one a `turn-working` resumed.
       */
      readonly midTurn?: boolean
    }
  | {
      readonly type: "attention-resolved"
      readonly requestId: string
      readonly actor: string | null
      readonly toolName: string
      readonly loose: boolean
      /**
       * Allowed, as its result's hook says, or settled however it was, as its result in
       * the transcript says: a prompt that timed out and denied it fires no hook.
       */
      readonly outcome: "allowed" | "settled"
      /** Whether the call failed as an abort, as Claude Code's `is_interrupt` says. */
      readonly interrupted?: true
    }
  | {
      readonly type: "subagent-started"
      readonly actor: string
      /** What kind of subagent it is, in the harness's own words. */
      readonly actorType: string | null
    }
  | { readonly type: "subagent-stopped"; readonly actor: string }
  /**
   * A subagent's turn aborted, its thread still open, as Codex's rollout records Esc on
   * its request, which no hook reports: what it asked by then waits on the person no
   * longer, and it runs on.
   */
  | { readonly type: "subagent-turn-aborted"; readonly actor: string }
  | { readonly type: "mode-observed"; readonly planning: boolean }
  | { readonly type: "plan-observed"; readonly actor: string | null; readonly plan: PlanSource }
)

/**
 * What a session's own records said of its tokens, quotas and model, each part only when
 * they named it: how full its context is, its rate-limit windows, the model's name and its
 * reasoning effort.
 */
export type TelemetryObserved = {
  readonly type: "telemetry-observed"
  readonly agent: AgentName
  readonly sessionId: string
  readonly instance: string | null
  readonly startedAt: number
  readonly context?: AgentTelemetry["context"]
  readonly limits?: AgentTelemetry["limits"]
  readonly model?: AgentTelemetry["model"]
  readonly effort?: AgentTelemetry["effort"]
}

/**
 * Work an ended turn left running that wakes the agent once done, counted: subagents, and
 * other tasks, as commands run in the background; and whether `more` runs that it doesn't
 * count, as Antigravity's Stop says only that something does. None is both zero, with no
 * more.
 */
export type Background = {
  readonly agents: number
  readonly tasks: number
  readonly more?: true
}

/** Where a plan is: a file the harness wrote it to, or its text when it named no file. */
export type PlanSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "text"; readonly text: string; readonly truncated: boolean }

/** A normalized fact a harness reported. */
export type HarnessEvent = SessionObserved | ActivityEvent | TelemetryObserved
