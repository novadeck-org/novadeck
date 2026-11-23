/**
 * The shipping gate's decision (see architecture/grants.md): given a shell command an agent is
 * about to run, say nothing (the harness decides, as it does without Novadeck), allow it
 * because a live permit covers every target it ships, or deny it. It is Novadeck's hook that
 * answers, as the harness prints it.
 *
 * Novadeck's deny is best effort, so every allow is exact: the whole command is allowed only
 * when each of its segments is a shipping action a permit covers (or a `cd`), and never one
 * with a tail, an expansion, or an option that runs a program.
 */
import { createHash } from "node:crypto"

import type { Permit, Permits } from "./permits.js"
import { readCommand, type Action, type Lookups } from "./reader.js"
import { covered, type AllowRule } from "./rules.js"

/**
 * What the hook prints for a command, and what to do once it is printed: a permit used up or a
 * Codex escalation remembered happens only when the answer was delivered in time (`commit`),
 * so an answer that came too late changes nothing.
 */
export type Decision = {
  readonly stdout: string
  readonly commit?: () => void
  /**
   * Antigravity's or opencode's hook stays silent because a permit covers the command: its own
   * confirmation follows, which the runner answers for this very call (`Shipping`).
   */
  readonly permitted?: true
  /**
   * opencode's permitted command, as the reading that allowed it holds it: opencode's default
   * asks nothing, so its hook has to spend the permits itself (`Shipping.spend`), not wait for a
   * dialog that may never come.
   */
  readonly covered?: Covered
}

/** The harnesses the gate answers for. */
export type GatedAgent = "claude" | "codex" | "agy" | "opencode"

export type GateInput = {
  readonly agent: GatedAgent
  readonly event: "PreToolUse" | "PermissionRequest"
  readonly terminalId: string
  readonly command: string
  readonly cwd: string
  /**
   * Claude Code's permission mode, as its hook says. Antigravity's hook names none: its is the
   * mode its status line last said, else the launch's (`--mode`), as the runner reads them.
   * opencode's is `bypass` where its launch skips every permission, else none.
   */
  readonly mode?: string
  /** Codex's rollout, which says what the turn's sandbox and approval policy are. */
  readonly transcript?: string
}

/** What a Codex turn runs under, as its rollout's `turn_context` says. */
export type Turn = {
  readonly approval?: string
  readonly sandbox?: string
}

export type GateDeps = {
  readonly lookups: (terminalId: string) => Lookups
  readonly permits: Permits
  /**
   * The person's allow rules for the session `agent` holds in a terminal, whose command runs in
   * `cwd`: its harness reads its project's in the folder it started in, not the command's.
   */
  readonly rules: (agent: GatedAgent, terminalId: string, cwd: string) => Promise<readonly AllowRule[]>
  /** The turn Codex's rollout last started; undefined when it can't be read. */
  readonly turn: (transcript: string | undefined) => Promise<Turn | undefined>
  readonly now?: () => number
}

/** What gave a permit, in words. */
export const describeSource = (source: Permit["source"]): string =>
  source.type === "quote" ? `the user said "${source.quote}"` : "the user allowed it on a card"

/** How long Novadeck remembers that it asked a Codex agent to escalate a command. */
export const escalationMs = 5 * 60_000

/** Whether a Codex turn is in bypass: no approvals and nothing to escalate from. */
const bypass = (turn: Turn | undefined): boolean =>
  turn?.approval === "never" && turn.sandbox === "danger-full-access"

/**
 * The mode `Shipping.agyMode` gives for Antigravity in an explicit bypass: its launch's
 * `--dangerously-skip-permissions`, or a status line mode that means skip. Every other mode
 * (default, `auto`, `accept-edits`, `plan`, one nobody told) is gated: `auto` still prompts before
 * irreversible actions, as Claude Code's auto mode does, and a deny is safe where agy's own
 * dialog decides what a permit covers.
 */
export const agyBypassMode = "bypass"

/**
 * The same word for opencode, in an explicit bypass: a launch with `--auto`, `--yolo` or
 * `--dangerously-skip-permissions` (one flag, three names: cli/cmd/tui.ts, 1.19.6), which has its
 * interface answer every permission it is asked. A person's own `permission: "allow"` is not one:
 * the gate's deny comes before opencode's permission check, so it holds there too.
 */
export const opencodeBypassMode = "bypass"

const restricted = (turn: Turn | undefined): boolean =>
  turn?.sandbox === "workspace-write" || turn?.sandbox === "read-only"

/** An action in plain words, from its permit key: the repository and numbers Novadeck resolved. */
export const describeKey = (key: string): string => {
  const [kind, rest = ""] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)]
  const at = rest.indexOf(":")
  const repo = at < 0 ? rest : rest.slice(0, at)
  const target = at < 0 ? "" : rest.slice(at + 1)
  switch (kind) {
    case "push":
      return `push to ${target} in ${repo}`
    case "push-force":
      return `force-push to ${target} in ${repo}`
    case "land":
      return `land work on ${target} in ${repo}`
    case "pr-create":
      return `open a PR into ${target === "@default" ? "the default branch" : target} in ${repo}`
    default: {
      const merge = /^(.*)#(\d+)$/.exec(rest)
      if (merge) return `merge PR #${merge[2]} in ${merge[1]}`
      const branch = /^(.*)@(.*)$/.exec(rest)
      return branch ? `merge the PR of ${branch[2]} in ${branch[1]}` : `ship ${key}`
    }
  }
}

const declare = (keys: readonly string[]): string =>
  `Novadeck: this ships work (${keys.map(describeKey).join("; ")}) and no permit covers it. request_permit gives a permit when the user's own words typed in this terminal cover it, and otherwise asks the user with a card for this action; their answer reaches you as a Novadeck notice, and the command can be run again after it.`

const escalate =
  "Novadeck: a permit covers this command, and the sandbox may block it. Run it again asking for escalation; Novadeck approves it."

/** What a hook prints for a decision, as each event and harness expects it. */
export const printed = (
  event: GateInput["event"],
  decision: "allow" | "deny",
  reason: string,
): string =>
  `${JSON.stringify(
    event === "PermissionRequest"
      ? {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision:
              decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: reason },
          },
        }
      : {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: decision,
            permissionDecisionReason: reason,
          },
        },
  )}\n`

/**
 * What Antigravity's hook prints to refuse a tool, as its PreToolUse answers read it (probed
 * 1.5.14). opencode's plugin reads the same words (`decision` and `reason`) and throws the reason.
 */
export const printedAgy = (reason: string): string =>
  `${JSON.stringify({ decision: "deny", reason })}\n`

/** A command's shipping, read, with the permits that cover it, once every action has one. */
export type Covered = {
  readonly permits: readonly Permit[]
  readonly actions: readonly Action[]
  /** Ends what the command's run uses up: single-use permits, and the merge permits it voids. */
  readonly used: () => void
  /**
   * Takes the single-use permits now, before the command is let run, so no other answer can
   * use them too; `restore` gives them back where it wasn't (never a standing permit, nor one a
   * revoke ended meanwhile), and `voided` ends the merge permits the command voids, once it was.
   * False, with nothing taken, where a permit no longer covers it (another call took a
   * single-use one, or a revoke or a close ended it since it was read).
   */
  readonly take: () => boolean
  readonly restore: () => void
  readonly voided: () => void
}

/** What a reading's permits give: see `Covered`. */
const coveredOf = (
  held: Permits,
  terminalId: string,
  actions: readonly Action[],
  permits: readonly Permit[],
): Covered => {
  let restores: (() => void)[] = []
  const voided = () => {
    for (const action of actions) for (const key of action.voids ?? []) held.revoke(key)
  }
  return {
    permits,
    actions,
    used: () => {
      for (const permit of permits) held.used(permit)
      voided()
    },
    take: () => {
      // Every permit must still be the live one, checked before any is taken, in one tick.
      if (permits.some((permit) => held.covering(terminalId, permit.key) !== permit)) return false
      restores = permits.flatMap((permit) => held.take(permit) ?? [])
      return true
    },
    restore: () => {
      for (const restore of restores) restore()
    },
    voided,
  }
}

export class Gate {
  // Commands a Codex agent was asked to escalate, by terminal and command, and until when.
  private readonly escalated = new Map<string, number>()

  constructor(private readonly deps: GateDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private remember(input: Pick<GateInput, "terminalId" | "command">): string {
    const hash = createHash("sha256").update(input.command).digest("hex")
    return `${input.terminalId}\n${hash}`
  }

  /**
   * What the hook prints for `input`: undefined for no opinion, so the harness decides as it
   * does without Novadeck, else a JSON line and what to do once it is printed.
   */
  async decide(input: GateInput): Promise<Decision | undefined> {
    // Claude Code's bypass mode, where it asks nothing: Novadeck adds no gate.
    if (input.agent === "claude" && input.mode === "bypassPermissions") return undefined
    // Antigravity told to skip every permission: nothing to replace.
    if (input.agent === "agy" && input.mode === agyBypassMode) return undefined
    if (input.agent === "opencode" && input.mode === opencodeBypassMode) return undefined
    const reading = await readCommand(input.command, input.cwd, this.deps.lookups(input.terminalId))
    if (reading.kind === "none") return undefined
    const turn = input.agent === "codex" ? await this.deps.turn(input.transcript) : undefined
    if (bypass(turn)) return undefined
    // Where the person's own rule allows the command, the harness had no gate there either.
    if (covered(await this.deps.rules(input.agent, input.terminalId, input.cwd), input.command))
      return undefined
    const refuse = (reason: string): Decision => ({
      stdout:
        input.agent === "agy" || input.agent === "opencode"
          ? printedAgy(reason)
          : printed(input.event, "deny", reason),
    })
    if (reading.refusal !== undefined)
      return refuse(
        `Novadeck: this command can't be allowed, because ${reading.refusal}. Run each shipping command on its own, spelled out.`,
      )
    const permits: Permit[] = []
    const missing: string[] = []
    for (const action of reading.actions) {
      const permit = this.deps.permits.covering(input.terminalId, action.key)
      if (permit) permits.push(permit)
      else missing.push(action.key)
    }
    if (missing.length > 0) return refuse(declare(missing))
    // Antigravity's hook has no allow: it stays silent, its own confirmation shows, and the
    // runner answers that one (`Shipping.autoAnswer`) only for this very command.
    if (input.agent === "agy") return { stdout: "", permitted: true }
    if (input.agent === "opencode")
      return {
        stdout: "",
        permitted: true,
        ...(reading.actions.length > 0 && {
          covered: coveredOf(this.deps.permits, input.terminalId, reading.actions, permits),
        }),
      }
    return this.allowed(input, permits, reading.actions, turn)
  }

  /**
   * The permits that cover `command` whole, where the reader reads it as shipping and every
   * action it ships has one, and nothing in it is refused: undefined otherwise, however close.
   * It is the same reading, with the same exactness, that allows a command for Claude Code.
   */
  async covered(terminalId: string, command: string, cwd: string): Promise<Covered | undefined> {
    const reading = await readCommand(command, cwd, this.deps.lookups(terminalId))
    if (reading.kind === "none" || reading.refusal !== undefined) return undefined
    if (reading.actions.length === 0) return undefined
    const permits: Permit[] = []
    for (const action of reading.actions) {
      const permit = this.deps.permits.covering(terminalId, action.key)
      if (!permit) return undefined
      permits.push(permit)
    }
    return coveredOf(this.deps.permits, terminalId, reading.actions, permits)
  }

  private allowed(
    input: Pick<GateInput, "agent" | "event" | "terminalId" | "command">,
    permits: readonly Permit[],
    actions: readonly Action[],
    turn: Turn | undefined,
  ): Decision {
    // Once delivered: single-use permits end, and a PR whose base the command changes loses
    // the merge permits it was given for where it merged before.
    const used = () => {
      for (const permit of permits) this.deps.permits.used(permit)
      for (const action of actions)
        for (const key of action.voids ?? []) this.deps.permits.revoke(key)
    }
    const note = `Novadeck permit: ${permits
      .map((permit) => `${describeKey(permit.key)} (${describeSource(permit.source)})`)
      .join("; ")}`
    if (input.agent === "claude")
      return { stdout: printed(input.event, "allow", note), commit: used }
    // Codex: a PreToolUse allow doesn't lift its sandbox, so a permitted command that the
    // sandbox may block is sent back once to run again asking to escalate, and the escalation
    // is what a PermissionRequest allows, once.
    if (input.event === "PermissionRequest")
      return { stdout: printed("PermissionRequest", "allow", note), commit: used }
    // No opinion is printed, so the sandbox's own decision stands: the permit is used here.
    if (!restricted(turn)) return { stdout: "", commit: used }
    const key = this.remember(input)
    const until = this.escalated.get(key)
    if (until !== undefined && until > this.now()) return { stdout: "" }
    return {
      stdout: printed("PreToolUse", "deny", escalate),
      commit: () => {
        // What is remembered is only what was asked of the agent, and the map is kept short.
        const now = this.now()
        for (const [each, over] of this.escalated) if (over <= now) this.escalated.delete(each)
        this.escalated.set(key, now + escalationMs)
      },
    }
  }
}

export type { Action }
