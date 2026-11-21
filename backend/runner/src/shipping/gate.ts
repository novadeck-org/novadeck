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

export type GateInput = {
  readonly agent: "claude" | "codex"
  readonly event: "PreToolUse" | "PermissionRequest"
  readonly terminalId: string
  readonly command: string
  readonly cwd: string
  /** Claude Code's permission mode, as its hook says. */
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
  /** The person's allow rules for `agent` in `cwd`. */
  readonly rules: (agent: "claude" | "codex", cwd: string) => Promise<readonly AllowRule[]>
  /** The turn Codex's rollout last started; undefined when it can't be read. */
  readonly turn: (transcript: string | undefined) => Promise<Turn | undefined>
  readonly now?: () => number
}

/** How long Novadeck remembers that it asked a Codex agent to escalate a command. */
export const escalationMs = 5 * 60_000

/** Whether a Codex turn is in bypass: no approvals and nothing to escalate from. */
const bypass = (turn: Turn | undefined): boolean =>
  turn?.approval === "never" && turn.sandbox === "danger-full-access"

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
  `Novadeck: this ships work (${keys.map(describeKey).join("; ")}) and no permit covers it. Declare it first with request_permit; it gives a permit when the user's own words in this terminal or their answer covers it. Then run the command again.`

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

export class Gate {
  // Commands a Codex agent was asked to escalate, by terminal and command, and until when.
  private readonly escalated = new Map<string, number>()

  constructor(private readonly deps: GateDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private remember(input: GateInput): string {
    const hash = createHash("sha256").update(input.command).digest("hex")
    return `${input.terminalId}\n${hash}`
  }

  /**
   * What the hook prints for `input`: undefined for no opinion, so the harness decides as it
   * does without Novadeck, else a JSON line.
   */
  async decide(input: GateInput): Promise<string | undefined> {
    // Claude Code's bypass mode, where it asks nothing: Novadeck adds no gate.
    if (input.agent === "claude" && input.mode === "bypassPermissions") return undefined
    const reading = await readCommand(input.command, input.cwd, this.deps.lookups(input.terminalId))
    if (reading.kind === "none") return undefined
    const turn = input.agent === "codex" ? await this.deps.turn(input.transcript) : undefined
    if (bypass(turn)) return undefined
    // Where the person's own rule allows the command, the harness had no gate there either.
    if (covered(await this.deps.rules(input.agent, input.cwd), input.command)) return undefined
    if (reading.refusal !== undefined)
      return printed(
        input.event,
        "deny",
        `Novadeck: this command can't be allowed, because ${reading.refusal}. Run each shipping command on its own, spelled out.`,
      )
    const permits: Permit[] = []
    const missing: string[] = []
    for (const action of reading.actions) {
      const permit = this.deps.permits.covering(input.terminalId, action.key)
      if (permit) permits.push(permit)
      else missing.push(action.key)
    }
    if (missing.length > 0) return printed(input.event, "deny", declare(missing))
    return this.allowed(input, permits, turn)
  }

  private allowed(
    input: GateInput,
    permits: readonly Permit[],
    turn: Turn | undefined,
  ): string | undefined {
    const used = () => {
      for (const permit of permits) this.deps.permits.used(permit)
    }
    const note = `Novadeck permit: ${permits.map((permit) => describeKey(permit.key)).join("; ")}`
    if (input.agent === "claude") {
      used()
      return printed(input.event, "allow", note)
    }
    // Codex: a PreToolUse allow doesn't lift its sandbox, so a permitted command that the
    // sandbox may block is sent back once to run again asking to escalate, and the escalation
    // is what a PermissionRequest allows, once.
    if (input.event === "PermissionRequest") {
      used()
      return printed("PermissionRequest", "allow", note)
    }
    if (!restricted(turn)) {
      used()
      return undefined
    }
    const key = this.remember(input)
    const until = this.escalated.get(key)
    if (until !== undefined && until > this.now()) return undefined
    this.escalated.set(key, this.now() + escalationMs)
    return printed("PreToolUse", "deny", escalate)
  }
}

export type { Action }
