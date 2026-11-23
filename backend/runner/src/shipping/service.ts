/**
 * The shipping gate as the runner holds it (see architecture/grants.md): its permits and the
 * ring of what the person typed, the decision, and the switch that turns it on. Everything is
 * in memory per terminal, so a restart fails closed.
 */
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { open } from "node:fs/promises"

import { agentLimits, type AgentName, type StandingPermit } from "@novadeck/protocol"

import { logs } from "../log.js"
import { noticeText } from "../messaging/notice-format.js"
import type { GateCall } from "../shell/hook.js"
import type { Record } from "../terminals/record.js"
import { Cards, type Card } from "./cards.js"
import {
  declare,
  ghDefault,
  ghPull,
  standing,
  type Declared,
  type DeclareAnswer,
} from "./declare.js"
import {
  agyBypassMode,
  describeKey,
  describeSource,
  Gate,
  printedAgy,
  type Decision,
  type Turn,
} from "./gate.js"
import { agyPreToolUse } from "./hooks.js"
import { defaultOf, gitLookups, validName, type Owned } from "./lookups.js"
import { Declines, Permits, Quotes, type Permit } from "./permits.js"
import { agyRules, claudeRules, codexRules } from "./rules.js"
import { shipsByRule } from "./shapes.js"

/** What the gate needs of the rest of the runner. */
export type ShippingHost = {
  /** Whether the Experimental shipping gate is on, read each time a hook comes. */
  readonly enabled: () => boolean
  readonly owned: Owned
  /** Tells the agent in a terminal something, as a Novadeck notice; whether it was queued. */
  readonly notify: (terminalId: string, text: string) => boolean
  /** Where the person's rule files are: the runner's own environment and home unless given. */
  readonly ruleFiles?: { readonly env: NodeJS.ProcessEnv; readonly home: string }
  /** Whether a PR, by its number or its head branch, is still open; `ghOpen` when left out. */
  readonly prOpen?: (repo: string, pr: string) => Promise<boolean | undefined>
}

/**
 * Whether `gh` says the PR (by number, or by its head branch) is open: false once it merged or
 * closed, undefined where gh can't say, as for a branch with no PR yet. Read with no change.
 */
export const ghOpen = (repo: string, pr: string): Promise<boolean | undefined> =>
  new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "view", pr, "-R", repo, "--json", "state", "--jq", ".state"],
      { timeout: 10_000, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
      (error, out) => resolve(error ? undefined : out.trim() === "OPEN"),
    )
  })

/** How often standing merge permits are checked against their PR: closed or merged, they end. */
export const sweepMs = 5 * 60_000

// A merge permit's repository and PR, as its key names them (`pr-merge:<repo>#<n>` or `@<branch>`; `pr-auto` and `pr-admin` too).
const mergeTarget = (key: string): { repo: string; pr: string } | undefined => {
  const match = /^pr-(?:merge|auto|admin):([^#@]+)[#@](.+)$/.exec(key)
  return match ? { repo: match[1]!, pr: match[2]! } : undefined
}

// The tail of a rollout read for its latest turn context: a turn starts well within it.
const tailBytes = 256 * 1024

/** What the last `turn_context` of a Codex rollout says the turn runs under. */
export const turnOf = async (transcript: string | undefined): Promise<Turn | undefined> => {
  if (transcript === undefined) return undefined
  try {
    const file = await open(transcript, "r")
    try {
      const { size } = await file.stat()
      const length = Math.min(size, tailBytes)
      const buffer = Buffer.alloc(length)
      await file.read(buffer, 0, length, size - length)
      const lines = buffer.toString("utf8").split("\n").toReversed()
      for (const line of lines) {
        if (!line.includes('"turn_context"')) continue
        const parsed = JSON.parse(line) as {
          type?: string
          payload?: { approval_policy?: unknown; sandbox_policy?: unknown }
        }
        if (parsed.type !== "turn_context") continue
        const sandbox = parsed.payload?.sandbox_policy
        const type =
          typeof sandbox === "string" ? sandbox : (sandbox as { type?: unknown } | undefined)?.type
        const approval = parsed.payload?.approval_policy
        return {
          ...(typeof approval === "string" && { approval }),
          ...(typeof type === "string" && { sandbox: type }),
        }
      }
    } finally {
      await file.close()
    }
  } catch {
    // Unreadable: nothing is known of the turn.
  }
  return undefined
}

const log = logs.for("shipping")

// Modes an Antigravity status line or launch may name that mean it skips every permission.
const skipping: ReadonlySet<string> = new Set(["bypass", "bypass-permissions"])

/** The mode a launch's `--mode` names (`--mode x`, `-mode x`, `--mode=x`): the last one, as agy reads flags. */
export const launchMode = (launch: readonly string[] | undefined): string | undefined => {
  let mode: string | undefined
  const words = launch ?? []
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]!
    if (word === "--mode" || word === "-mode") mode = words[(at += 1)]
    else if (/^--?mode=/.test(word)) mode = word.slice(word.indexOf("=") + 1)
  }
  return mode
}

/** What a hook prints, and the lease that says it was printed (null where nothing waits on that). */
export type GateAnswer = { readonly stdout: string; readonly leaseId: string | null }

// The room an acknowledgement has past the hook's deadline: the relay's own margin to print.
const ackSlackMs = 500

/** `work`, or undefined once `ms` have passed. */
const within = async <T>(work: Promise<T>, ms: number): Promise<T | undefined> => {
  if (ms <= 0) return undefined
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A permitted command Antigravity's hook let through, until its confirmation answers it or it
 * lapses: the call (Antigravity's step, which names the request of its confirmation), the raw
 * command as the hook saw it whole, and where it runs.
 */
type Pending = {
  readonly requestId: string
  /** The call, as its hook named it: its conversation's step and its command. */
  readonly key: string
  readonly command: string
  readonly cwd: string
  readonly at: number
  readonly until: number
}

const failedText =
  "Novadeck: it couldn't decide this command, which ships work, in time, so it isn't allowed now. Run it again in a moment, on its own."

/** A call as its hook named it: the conversation's step and a hash of its command. */
const callKey = (call: GateCall): string =>
  `${call.conversation ?? ""}:${call.step ?? ""}:${createHash("sha256").update(call.command).digest("hex")}`

/** How long a permitted command waits for its confirmation: the dialog follows its hook at once. */
export const pendingMs = 30_000
// The dialog's request is stamped by a status line's hook, which may start a little before the
// runner's own clock reads the PreToolUse's answer.
const askedSlackMs = 200

export class Shipping {
  // A permit stands for the agent session it was given in, as the quote ring does, and a card
  // for the session that asked.
  private readonly session = (terminalId: string): string | undefined =>
    this.records.get(terminalId)?.bound?.binding.sessionId
  readonly permits = new Permits(Date.now, { session: this.session })
  readonly quotes = new Quotes()
  readonly declines = new Declines(this.quotes, this.session)
  readonly cards = new Cards(Date.now, { session: this.session })
  private readonly gate: Gate
  // Answers handed to a hook whose effect waits for its acknowledgement, by lease.
  private readonly leases = new Map<
    string,
    { terminalId: string; commit: () => void; expires: number }
  >()

  constructor(private readonly host: ShippingHost) {
    this.gate = new Gate({
      lookups: (terminalId) => gitLookups(terminalId, host.owned),
      permits: this.permits,
      declined: (terminalId, key) => this.declines.declined(terminalId, key),
      carded: (terminalId, key) => this.cards.covering(terminalId, key) !== undefined,
      rules: (agent, terminalId, cwd) => {
        const folder = this.sessionFolder(terminalId, agent) ?? cwd
        const { env, home } = host.ruleFiles ?? {}
        return agent === "claude"
          ? claudeRules(folder, env, home)
          : agent === "codex"
            ? codexRules(folder, env, home)
            : agyRules(home)
      },
      turn: turnOf,
      session: this.session,
      turnSeen: (terminalId, turn) => {
        if (turn === undefined) this.turns.delete(terminalId)
        else this.turns.set(terminalId, turn)
      },
      cantEscalate: (terminalId, turn) =>
        host.notify(
          terminalId,
          noticeText("Shipping", {
            facts: `This Codex session runs in a ${turn.sandbox} sandbox with approvals set to never, so it can't ask to escalate. A command a permit covers runs inside the sandbox, which decides whether it can.`,
            actions: [],
          }),
        ),
    })
    // Every permit is on record: who, what, where, on whose word, and when.
    this.permits.onGiven((permit) => {
      log.info("shipping.permit", `Novadeck permitted ${describeKey(permit.key)}`, {
        data: {
          terminalId: permit.terminalId,
          agent: this.agentOf(permit.terminalId) ?? null,
          action: describeKey(permit.key),
          target: permit.key,
          singleUse: permit.singleUse,
          source: describeSource(permit.source),
          ...(permit.source.type === "quote" && { quote: permit.source.quote }),
          ...(permit.source.type === "answer" && {
            card: permit.source.card,
            client: permit.source.client ?? null,
          }),
          at: new Date().toISOString(),
        },
      })
    })
    // An open card is withdrawn when another source gives the permit.
    this.permits.onGiven((permit) => {
      const card = this.cards.covering(permit.terminalId, permit.key)
      if (card && permit.source.type !== "answer") this.cards.close(card)
    })
  }

  /** `request_permit`: see `declare`. */
  async declare(terminalId: string, input: Declared): Promise<DeclareAnswer> {
    const cwd = this.cwd(terminalId)
    if (cwd === undefined)
      return { ok: false, reason: "Novadeck can't tell where this terminal is." }
    return await declare(
      {
        lookups: (id) => gitLookups(id, this.host.owned),
        permits: this.permits,
        quotes: this.quotes,
        declines: this.declines,
        cards: this.cards,
        pull: ghPull,
        valid: validName,
        defaultBranch: async (folder, repo) =>
          (await defaultOf(folder)) ?? (await ghDefault(folder, repo)),
        agentOf: (id) => this.agentOf(id),
        canEscalate: (id) => this.canEscalate(id),
      },
      terminalId,
      cwd,
      input,
    )
  }

  /**
   * The person answered a card: Allow gives the terminal's permit for the card's targets,
   * and either way the agent is told, as a Novadeck notice.
   */
  answered(card: Card, allow: boolean, client?: string): void {
    this.cards.close(card)
    if (!allow) this.declines.decline(card.terminalId, card.keys)
    if (!allow)
      log.info("shipping.declined", `The user declined: ${card.title}`, {
        data: {
          terminalId: card.terminalId,
          card: card.id,
          client: client ?? null,
          at: new Date().toISOString(),
        },
      })
    if (allow)
      for (const key of card.keys)
        this.permits.give(
          card.terminalId,
          key,
          card.singleUse,
          { type: "answer", card: card.id, ...(client !== undefined && { client }) },
          { group: card.id, title: card.title.replace(/\?$/, "") },
        )
    const what = describeKey(card.keys[0]!)
    this.host.notify(
      card.terminalId,
      noticeText("Shipping", {
        facts: allow
          ? `The user allowed it: ${card.title} (${what}). ${standing(card.singleUse)}`
          : `The user declined it: ${card.title} (${what}). No permit was given.`,
        actions: allow
          ? [
              "run the command on its own, as declared" +
                (this.agentOf(card.terminalId) === "codex"
                  ? this.canEscalate(card.terminalId)
                    ? "; if the sandbox blocks it, run it again asking for escalation"
                    : "; this Codex session can't escalate, so the sandbox decides whether it runs"
                  : ""),
            ]
          : [],
      }),
    )
  }

  private records: ReadonlyMap<string, Pick<Record, "summary" | "bound" | "agents">> = new Map()

  /**
   * Joins the runner's terminals: the folder each shell is in and the agent it runs, which the
   * gate reads, and what to publish when a terminal's open cards change.
   */
  attach<R extends Pick<Record, "summary" | "bound" | "agents">>(
    records: ReadonlyMap<string, R>,
    changed: (record: R) => void,
  ): void {
    this.records = records
    this.cards.watch((terminalId) => {
      const record = records.get(terminalId)
      if (record) changed(record)
    })
    // A permit given, used or ended changes what the person sees stand.
    this.permits.watch((terminalId) => {
      const record = records.get(terminalId)
      if (record) changed(record)
      this.sweepWhileStanding()
    })
  }

  private cwd(terminalId: string): string | undefined {
    return this.records.get(terminalId)?.summary.cwd
  }

  /**
   * The folder the session `agent` holds in a terminal started in, where its harness reads its
   * project's files: where it bound, which stays its folder whatever a later command `cd`s to.
   */
  private sessionFolder(terminalId: string, agent: AgentName): string | undefined {
    const record = this.records.get(terminalId)
    if (record?.bound?.binding.agent !== agent) return undefined
    return record.agents[agent]?.cwd
  }

  // What each Codex terminal's latest turn said it runs under, as the gate read it.
  private readonly turns = new Map<string, Turn>()

  /** Whether the Codex agent in a terminal can escalate: not where its approvals are `never`. */
  private canEscalate(terminalId: string): boolean {
    return this.turns.get(terminalId)?.approval !== "never"
  }

  private agentOf(terminalId: string): "claude" | "codex" | "agy" | undefined {
    return this.records.get(terminalId)?.bound?.binding.agent
  }

  /** Whether the gate is on. */
  enabled(): boolean {
    return this.host.enabled()
  }

  /** The cards open in a terminal, oldest first; none while the gate is off. */
  cardsOf(terminalId: string): readonly Card[] {
    return this.host.enabled() ? this.cards.of(terminalId) : []
  }

  /**
   * Whether the gate is on and covers `agent`'s harness: all three, but for Antigravity where it
   * has no PreToolUse hook (Windows, where cmd prints before hooks): nothing is refused there, so
   * nobody is told of permits, and agy's own dialog is the only one asked.
   */
  covers(agent: AgentName): boolean {
    if (!this.host.enabled()) return false
    return agent === "agy" ? agyPreToolUse() : agent === "claude" || agent === "codex"
  }

  /**
   * Whether the gate answers `agent`'s `event`: Claude's and Antigravity's PreToolUse, Codex's
   * PreToolUse and PermissionRequest. Antigravity's answers only to deny: a permitted command
   * stays silent there, and its own confirmation is answered from the screen (`autoAnswer`).
   */
  gating(agent: AgentName, event: string): boolean {
    if (!this.host.enabled()) return false
    if (agent === "claude" || agent === "agy") return event === "PreToolUse"
    return agent === "codex" && (event === "PreToolUse" || event === "PermissionRequest")
  }

  // The mode each Antigravity process's status line last said (`cycle_mode`: `""` for its Default
  // mode, `auto`, `accept-edits`, `plan`), by terminal, with the process that said it: one that a
  // restart in the same terminal replaced says nothing of the next.
  private readonly modes = new Map<string, { mode: string | null; instance: string | null }>()

  /** An Antigravity status line came: the mode it names, or none (an older agy). */
  statusLine(
    terminalId: string,
    payload: { readonly [key: string]: unknown },
    instance: string | null = null,
  ): void {
    const mode = payload.cycle_mode
    this.modes.set(terminalId, { mode: typeof mode === "string" ? mode : null, instance })
  }

  /**
   * The mode an Antigravity process runs in, for the gate: `bypass` where it was told to skip
   * every permission (its launch's `--dangerously-skip-permissions`, or a status line mode that
   * means it), else its status line's latest, which follows a Shift+Tab switch, else the
   * launch's `--mode`, else `""`: not told, which the gate treats as gated.
   */
  agyMode(
    terminalId: string,
    launch: readonly string[] | undefined,
    instance: string | null = null,
  ): string {
    if (launch?.includes("--dangerously-skip-permissions")) return agyBypassMode
    const live = this.modes.get(terminalId)
    // With no process known, an earlier status line may be another process's: it says nothing.
    const told =
      live !== undefined && instance !== null && live.instance === instance ? live.mode : null
    const mode = told ?? launchMode(launch) ?? ""
    return skipping.has(mode) ? agyBypassMode : mode
  }

  // The permitted commands Antigravity's hook let through, by terminal: each is the very command
  // its confirmation will ask about, checked as covered when the hook saw it.
  private readonly pending = new Map<string, Pending[]>()
  // Every Antigravity run_command hook the gate was asked about, by terminal, of any actor (its
  // subagents' hooks fire too, with steps of their own), decided either way, for `pendingMs`
  // and a little more: the confirmation of a call is told apart from another's only where no
  // other call was in flight around it. A call the hook denied runs nothing and shows no dialog,
  // so it is no such call (`denied`).
  private readonly hooked = new Map<string, { at: number; key: string; denied: boolean }[]>()
  // The confirmations looked at, by terminal and request: each is decided once.
  private readonly looked = new Set<string>()

  /** Whether `ref`'s confirmation is looked at for the first time, which it is only once. */
  firstLook(terminalId: string, ref: string, live: readonly string[]): boolean {
    const keep = new Set(live.map((each) => `${terminalId}\n${each}`))
    for (const key of this.looked)
      if (key.startsWith(`${terminalId}\n`) && !keep.has(key)) this.looked.delete(key)
    const key = `${terminalId}\n${ref}`
    if (this.looked.has(key)) return false
    this.looked.add(key)
    return true
  }

  /**
   * What to type into Antigravity's own confirmation of a command, as the person would: the run
   * once option, only for the very call the hook vetted a moment before, and never for a dialog
   * that cuts its command. The hook, silent because a permit covers the command, noted the call's
   * step and its raw command whole. The press needs all of these:
   * - the dialog shows the command whole (`whole`: the screen's rows, read by the caller, hold all
   *   of it and no mark of a cut), and its detail and the request's input both equal the note's
   *   command exactly;
   * - the request is the note's call (`requestId`), asked after the note;
   * - exactly one note is live for the terminal, and no other run_command hook, of any actor, was
   *   seen within `pendingMs` of it, before or after;
   * - a permit still covers the command.
   * The permit is taken before anything is typed (`release` gives it back where nothing was
   * pressed; `done` says the keys went), so two dialogs never both use a single-use one.
   * Undefined (the person answers) in any doubt.
   */
  async autoAnswer(
    terminalId: string,
    agent: AgentName,
    dialog: {
      readonly detail: string
      readonly requestId: string
      readonly call: string | undefined
      readonly askedAt: number
      readonly whole: boolean
    },
  ): Promise<
    | {
        readonly note: string
        /** The keys were typed. */
        readonly done: () => void
        /** Nothing was pressed: the permit goes back. */
        readonly release: () => void
      }
    | undefined
  > {
    if (!this.covers(agent) || agent !== "agy" || !dialog.whole) return undefined
    const now = Date.now()
    const live = (this.pending.get(terminalId) ?? []).filter((each) => each.until > now)
    this.pending.set(terminalId, live)
    // Exactly one waits; two could be either's dialog.
    const [entry] = live
    if (live.length !== 1 || entry === undefined) return undefined
    if (dialog.requestId !== entry.requestId) return undefined
    if (dialog.askedAt < entry.at - askedSlackMs) return undefined
    if (dialog.detail !== entry.command || dialog.call !== entry.command) return undefined
    // Any other call's hook near it: its dialog, or the request's call, may be that one's.
    const near = (this.hooked.get(terminalId) ?? []).some(
      (each) => each.key !== entry.key && !each.denied && Math.abs(each.at - entry.at) <= pendingMs,
    )
    if (near) return undefined
    try {
      const covered = await this.gate.covered(terminalId, entry.command, entry.cwd)
      if (!covered) return undefined
      // The entry answers one dialog, and the permit is taken with it (synchronously, so nothing
      // else reads either between).
      const left = (this.pending.get(terminalId) ?? []).filter((each) => each !== entry)
      if (left.length === (this.pending.get(terminalId) ?? []).length) return undefined
      this.pending.set(terminalId, left)
      covered.take()
      return {
        note: covered.permits
          .map((permit) => `${describeKey(permit.key)} (${describeSource(permit.source)})`)
          .join("; "),
        // Keys went: the permits are used, a standing one keeping only its retry window, and
        // whatever the command voids ends.
        done: covered.used,
        release: covered.restore,
      }
    } catch {
      return undefined
    }
  }

  /**
   * What the hook of `agent` in `terminalId` prints for a shell command, or undefined for no
   * opinion; a failure, or an answer that wouldn't be ready by `until` (the hook's own
   * deadline), is no opinion, never an allow. An answer with an effect (a permit used up, a
   * Codex escalation remembered) carries a lease, and the effect happens when the hook
   * acknowledges it printed it (`acknowledged`), never before.
   */
  async answer(
    terminalId: string,
    agent: AgentName,
    call: GateCall,
    until: number = Date.now() + 3_000,
  ): Promise<GateAnswer | undefined> {
    if (!this.gating(agent, call.event)) return undefined
    if (agent !== "claude" && agent !== "codex" && agent !== "agy") return undefined
    const saw = agent === "agy" ? this.sawHook(terminalId, call) : undefined
    let decision: Decision | undefined
    let failed = false
    try {
      // `decide` has no opinion as undefined, and late is no answer: told apart by the wrapper.
      const decided = await within(
        this.gate
          .decide({
            agent,
            event: call.event,
            terminalId,
            command: call.command,
            cwd: call.cwd,
            ...(agent === "agy"
              ? { mode: this.agyMode(terminalId, call.launch, call.instance ?? null) }
              : call.mode !== undefined && { mode: call.mode }),
            ...(call.transcript !== undefined && { transcript: call.transcript }),
          })
          .then((got) => ({ got })),
        until - Date.now(),
      )
      if (decided === undefined) failed = true
      else decision = decided.got
    } catch {
      failed = true
    }
    // Antigravity's rules run the commands of their shapes unasked where the hook says "ask", which
    // it does for a hook that failed or was late: those are refused, never left to a rule.
    if (agent === "agy" && failed && shipsByRule(call.command)) {
      if (saw) saw.denied = true
      return { stdout: printedAgy(failedText), leaseId: null }
    }
    // A deny runs nothing and shows no dialog.
    if (saw && decision !== undefined && decision.stdout !== "") saw.denied = true
    if (agent === "agy" && decision?.permitted)
      await this.recordPending(terminalId, call, call.instance ?? null)
    if (decision === undefined) return undefined
    const { stdout, commit } = decision
    if (commit === undefined) return stdout === "" ? undefined : { stdout, leaseId: null }
    const now = Date.now()
    for (const [id, lease] of this.leases) if (lease.expires <= now) this.leases.delete(id)
    const leaseId = randomUUID()
    this.leases.set(leaseId, { terminalId, commit, expires: until + ackSlackMs })
    return { stdout, leaseId }
  }

  /** Remembers that this call's hook was asked about, whoever's it is. */
  private sawHook(terminalId: string, call: GateCall): { denied: boolean } {
    const now = Date.now()
    const seen = (this.hooked.get(terminalId) ?? []).filter((each) => each.at > now - 2 * pendingMs)
    const hook = { at: now, key: callKey(call), denied: false }
    seen.push(hook)
    this.hooked.set(terminalId, seen)
    return hook
  }

  /**
   * A permitted shipping command Antigravity's hook let through, unless it is told to skip every
   * permission: noted for `pendingMs`, for its confirmation's auto-answer, under its step. Never
   * an answer of the hook's own. A call with no step, or whose command the hook didn't see
   * whole, is not noted: its confirmation can't be told from another's.
   */
  private async recordPending(
    terminalId: string,
    call: GateCall,
    instance: string | null,
  ): Promise<void> {
    try {
      if (call.step === undefined) return
      // The shim's rules run these with no dialog: nothing is to be answered, so nothing is noted.
      if (shipsByRule(call.command)) return
      if (this.agyMode(terminalId, call.launch, instance) === agyBypassMode) return
      if (!(await this.gate.covered(terminalId, call.command, call.cwd))) return
      const now = Date.now()
      const live = (this.pending.get(terminalId) ?? []).filter((each) => each.until > now)
      live.push({
        requestId: `confirmation:run_command:${call.step}`,
        key: callKey(call),
        command: call.command,
        cwd: call.cwd,
        at: now,
        until: now + pendingMs,
      })
      this.pending.set(terminalId, live)
    } catch {
      // Not noted: the person answers.
    }
  }

  /** The hook printed what a lease delivered: its effect happens, if it was in time. */
  acknowledged(terminalId: string, leaseId: string): void {
    const lease = this.leases.get(leaseId)
    if (lease?.terminalId !== terminalId) return
    this.leases.delete(leaseId)
    if (lease.expires > Date.now()) lease.commit()
  }

  /**
   * What the gate holds for the person in a terminal: its open cards, and the permits that
   * stand there, one for each declaration or card that gave them, oldest first. Nothing while
   * the gate is off.
   */
  held(terminalId: string): {
    readonly cards: readonly Card[]
    readonly permits: StandingPermit[]
  } {
    if (!this.host.enabled()) return { cards: [], permits: [] }
    const groups = new Map<string, Permit>()
    for (const permit of this.permits.of(terminalId))
      if (!groups.has(permit.group)) groups.set(permit.group, permit)
    const permits = [...groups.values()].slice(0, agentLimits.permits).map((permit) => ({
      id: permit.group,
      title: permit.title.slice(0, agentLimits.subject),
      quote:
        permit.source.type === "quote" ? permit.source.quote.slice(0, agentLimits.quote) : null,
      givenAt: permit.givenAt,
      until: permit.until,
      usedAt: permit.usedAt,
    }))
    return { cards: this.cardsOf(terminalId), permits }
  }

  /**
   * The person took back a permit that stood in a terminal: it ends with every target it
   * covered, and the agent is told. Whether one stood; undefined for a terminal it doesn't know.
   */
  takeBack(terminalId: string, group: string, client?: string): boolean | undefined {
    if (!this.records.has(terminalId)) return undefined
    const permit = this.permits.of(terminalId).find((each) => each.group === group)
    if (!permit) return false
    const keys = this.permits
      .of(terminalId)
      .filter((each) => each.group === group)
      .map((each) => each.key)
    if (!this.permits.takeBack(terminalId, group)) return false
    this.declines.decline(terminalId, keys)
    log.info("shipping.taken-back", `The user took back a permit: ${permit.title}`, {
      data: {
        terminalId,
        target: permit.key,
        client: client ?? null,
        at: new Date().toISOString(),
      },
    })
    this.host.notify(
      terminalId,
      noticeText("Shipping", {
        facts: `The user took back the permit: ${permit.title}. No permit covers it now.`,
        actions: [],
      }),
    )
    return true
  }

  private sweeper: NodeJS.Timeout | undefined

  // Checks the standing merge permits while any stand, and stops once none do.
  private sweepWhileStanding(): void {
    const merges = [...this.records.keys()].some((terminalId) =>
      this.permits
        .of(terminalId)
        .some((permit) => mergeTarget(permit.key) && permit.usedAt === null),
    )
    if (merges && this.sweeper === undefined) {
      this.sweeper = setInterval(() => void this.sweep(), sweepMs)
      this.sweeper.unref()
    } else if (!merges && this.sweeper !== undefined) {
      clearInterval(this.sweeper)
      this.sweeper = undefined
    }
  }

  /**
   * Ends every unused merge permit whose PR merged or closed, as GitHub says now: each group
   * once, whichever of its targets says so. A PR gh can't read keeps its permit.
   */
  async sweep(terminalIds: Iterable<string> = this.records.keys()): Promise<void> {
    const isOpen = this.host.prOpen ?? ghOpen
    for (const terminalId of terminalIds)
      for (const permit of this.permits.of(terminalId)) {
        // One of its group's targets may have ended it already.
        const still = this.permits.covering(terminalId, permit.key)
        const target = still?.usedAt === null ? mergeTarget(permit.key) : undefined
        // eslint-disable-next-line no-await-in-loop -- One PR at a time keeps gh's load low.
        if (target && (await isOpen(target.repo, target.pr)) === false)
          if (this.permits.takeBack(terminalId, permit.group))
            log.info("shipping.ended", `A permit ended, its PR closed: ${permit.title}`, {
              data: { terminalId, target: permit.key, at: new Date().toISOString() },
            })
      }
  }

  /**
   * The gate was switched on or off: off, every permit and card ends, and the summaries say so,
   * so nothing stands on the wire meanwhile and none comes back when it is on again.
   */
  switched(): void {
    if (this.host.enabled()) return
    this.permits.clear()
    this.declines.clear()
    for (const terminalId of this.records.keys()) {
      this.cards.forget(terminalId)
      this.quotes.forget(terminalId)
    }
  }

  /** A terminal closed: its permits and quotes go. */
  closed(terminalId: string): void {
    this.permits.forget(terminalId)
    this.declines.forget(terminalId)
    this.quotes.forget(terminalId)
    this.cards.forget(terminalId)
    this.turns.delete(terminalId)
    this.modes.delete(terminalId)
    this.pending.delete(terminalId)
    this.hooked.delete(terminalId)
    for (const key of this.looked) if (key.startsWith(`${terminalId}\n`)) this.looked.delete(key)
  }
}
