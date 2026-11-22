/**
 * The shipping gate as the runner holds it (see architecture/grants.md): its permits and the
 * ring of what the person typed, the decision, and the switch that turns it on. Everything is
 * in memory per terminal, so a restart fails closed.
 */
import { createHash, randomUUID } from "node:crypto"
import { open } from "node:fs/promises"

import type { AgentName } from "@novadeck/protocol"

import { logs } from "../log.js"
import { noticeText } from "../messaging/notice-format.js"
import type { GateCall } from "../shell/hook.js"
import type { Record } from "../terminals/record.js"
import { Cards, type Card } from "./cards.js"
import { declare, ghDefault, ghPull, type Declared, type DeclareAnswer } from "./declare.js"
import {
  agyBypassMode,
  describeKey,
  describeSource,
  Gate,
  opencodeBypassMode,
  printedAgy,
  type Decision,
  type Turn,
} from "./gate.js"
import { agyPreToolUse } from "./hooks.js"
import { defaultOf, gitLookups, validName, type Owned } from "./lookups.js"
import { Permits, Quotes } from "./permits.js"
import { agyRules, claudeRules, codexRules } from "./rules.js"
import { shipsByRule } from "./shapes.js"

/** What the gate needs of the rest of the runner. */
export type ShippingHost = {
  /** Whether the Experimental shipping gate is on, read each time a hook comes. */
  readonly enabled: () => boolean
  readonly owned: Owned
  /** Tells the agent in a terminal something, as a Novadeck notice; whether it was queued. */
  readonly notify: (terminalId: string, text: string) => boolean
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

// The names of opencode's one skip-permissions flag (cli/cmd/tui.ts, 1.19.6): its interface then
// answers every permission, as `auto`.
const opencodeSkips: ReadonlySet<string> = new Set(["auto", "yolo", "dangerously-skip-permissions"])

/**
 * Whether a launch's words skip every permission, as opencode's flags read (yargs, booleans: a
 * bare flag, `=true`, a following `true`; `=false`, a following `false` or `--no-<name>` turn it
 * off; the last of each name wins, and any name on skips). Words after `--` are the prompt's.
 */
export const opencodeSkipsPermissions = (launch: readonly string[] | undefined): boolean => {
  const words = launch ?? []
  const on = new Map<string, boolean>()
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]!
    if (word === "--") break
    const found = /^--(no-)?([a-z-]+)(?:=(.*))?$/.exec(word)
    if (!found || !opencodeSkips.has(found[2]!)) continue
    const negated = found[1] !== undefined
    let value = !negated
    if (found[3] !== undefined) value = negated ? false : found[3] !== "false"
    else if (words[at + 1] === "true" || words[at + 1] === "false") {
      value = (words[at + 1] === "true") !== negated
      at += 1
    }
    on.set(found[2]!, value)
  }
  return [...on.values()].some(Boolean)
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

/**
 * A permitted command opencode's hook let through, until its `bash` permission asks about it or
 * it lapses: its session and call (which the permission's request names too), the raw command as
 * the hook saw it whole, and where it runs.
 */
type Vetted = {
  readonly conversation: string
  readonly call: string
  readonly command: string
  readonly cwd: string
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
  readonly permits = new Permits()
  readonly quotes = new Quotes()
  readonly cards = new Cards()
  private readonly gate: Gate
  // Answers handed to a hook whose effect waits for its acknowledgement, by lease.
  private readonly leases = new Map<
    string,
    {
      terminalId: string
      commit: () => void
      expires: number
      /** Where the answer took a permit: given back if the hook never printed it in time. */
      timer?: NodeJS.Timeout
    }
  >()

  constructor(private readonly host: ShippingHost) {
    this.gate = new Gate({
      lookups: (terminalId) => gitLookups(terminalId, host.owned),
      permits: this.permits,
      rules: (agent, cwd) =>
        agent === "claude"
          ? claudeRules(cwd)
          : agent === "codex"
            ? codexRules()
            : agent === "agy"
              ? agyRules()
              : // opencode's merged configuration can't be read exactly (global, project, agents,
                // environment), so its person's own allow rules never lift the gate: its deny
                // comes before opencode's permission check, and an unknown case is gated.
                Promise.resolve([]),
      turn: turnOf,
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
        cards: this.cards,
        pull: ghPull,
        valid: validName,
        defaultBranch: async (folder, repo) =>
          (await defaultOf(folder)) ?? (await ghDefault(folder, repo)),
        agentOf: (id) => this.agentOf(id),
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
        this.permits.give(card.terminalId, key, card.singleUse, {
          type: "answer",
          card: card.id,
          ...(client !== undefined && { client }),
        })
    const what = describeKey(card.keys[0]!)
    this.host.notify(
      card.terminalId,
      noticeText("Shipping", {
        facts: allow
          ? `The user allowed it: ${card.title} (${what}). The permit holds for ten minutes.`
          : `The user declined it: ${card.title} (${what}). No permit was given.`,
        actions: allow
          ? [
              "run the command on its own, as declared" +
                (this.agentOf(card.terminalId) === "codex"
                  ? "; if the sandbox blocks it, run it again asking for escalation"
                  : ""),
            ]
          : [],
      }),
    )
  }

  private records: ReadonlyMap<string, Pick<Record, "summary" | "bound">> = new Map()

  /**
   * Joins the runner's terminals: the folder each shell is in and the agent it runs, which the
   * gate reads, and what to publish when a terminal's open cards change.
   */
  attach<R extends Pick<Record, "summary" | "bound">>(
    records: ReadonlyMap<string, R>,
    changed: (record: R) => void,
  ): void {
    this.records = records
    this.cards.watch((terminalId) => {
      const record = records.get(terminalId)
      if (record) changed(record)
    })
  }

  private cwd(terminalId: string): string | undefined {
    return this.records.get(terminalId)?.summary.cwd
  }

  private agentOf(terminalId: string): AgentName | undefined {
    return this.records.get(terminalId)?.bound?.binding.agent
  }

  /** Whether the gate is on. */
  enabled(): boolean {
    return this.host.enabled()
  }

  /**
   * Whether the gate is on and covers `agent`'s harness: Claude Code, Codex, Antigravity and
   * opencode, but Antigravity not where it has no PreToolUse hook (Windows, where cmd prints before
   * hooks): nothing is refused there, so nobody is told of permits, and agy's own dialog is the
   * only one asked. opencode's plugin runs its hook through `cmd /d` there, which skips the
   * AutoRun, so it is covered everywhere its plugin loads (`hooksTrusted`).
   */
  covers(agent: AgentName): boolean {
    if (!this.host.enabled()) return false
    return agent === "agy" ? agyPreToolUse() : true
  }

  /**
   * Whether the gate answers `agent`'s `event`: Claude's and Antigravity's PreToolUse, Codex's
   * and opencode's PreToolUse and PermissionRequest. Antigravity's and opencode's PreToolUse
   * answer only to deny: a permitted command stays silent there, and its own confirmation is
   * answered for the very call the hook vetted (Antigravity's from the screen, `autoAnswer`;
   * opencode's by its permission request, `confirmed`).
   */
  gating(agent: AgentName, event: string): boolean {
    if (!this.host.enabled()) return false
    if (agent === "claude" || agent === "agy") return event === "PreToolUse"
    return (
      (agent === "codex" || agent === "opencode") &&
      (event === "PreToolUse" || event === "PermissionRequest")
    )
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
        done: covered.voided,
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
    if (agent !== "claude" && agent !== "codex" && agent !== "agy" && agent !== "opencode")
      return undefined
    if (agent === "opencode" && call.event === "PermissionRequest")
      return await this.confirmed(terminalId, call, until)
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
              : agent === "opencode"
                ? opencodeSkipsPermissions(call.launch) && { mode: opencodeBypassMode }
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
    // it does for a hook that failed or was late: those are refused, never left to a rule. opencode
    // has no rule of Novadeck's, but a person's own `permission: "allow"` runs the same shapes
    // unasked where its hook gave no answer: the same two are refused.
    if ((agent === "agy" || agent === "opencode") && failed && shipsByRule(call.command)) {
      if (saw) saw.denied = true
      return { stdout: printedAgy(failedText), leaseId: null }
    }
    // A deny runs nothing and shows no dialog.
    if (saw && decision !== undefined && decision.stdout !== "") saw.denied = true
    if (agent === "agy" && decision?.permitted)
      await this.recordPending(terminalId, call, call.instance ?? null)
    if (agent === "opencode" && decision?.permitted) await this.vet(terminalId, call)
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

  // The permitted commands opencode's hook let through, by terminal: each is the call whose `bash`
  // permission will ask about exactly that command, checked as covered when the hook saw it.
  private readonly vetted = new Map<string, Vetted[]>()

  /**
   * A permitted shipping command opencode's hook let through: noted for `pendingMs` under its
   * session and call, for its permission's answer (`confirmed`). Never an answer of the hook's own.
   * A call the hook didn't name is not noted: its permission can't be told from another's.
   */
  private async vet(terminalId: string, call: GateCall): Promise<void> {
    try {
      if (call.call === undefined || call.conversation === undefined) return
      if (!(await this.gate.covered(terminalId, call.command, call.cwd))) return
      const now = Date.now()
      const live = (this.vetted.get(terminalId) ?? []).filter((each) => each.until > now)
      live.push({
        conversation: call.conversation,
        call: call.call,
        command: call.command,
        cwd: call.cwd,
        until: now + pendingMs,
      })
      this.vetted.set(terminalId, live)
    } catch {
      // Not noted: the person answers.
    }
  }

  /**
   * What the plugin does with opencode's `bash` permission: `{"reply":"once"}` for a request that is
   * for the very call the hook vetted a moment before (the same session and call, the command in
   * its metadata equal to the vetted raw command exactly), while a permit still covers the command,
   * and undefined (the person answers) in any doubt. The note answers one request, whatever comes
   * of it, and the single-use permit is taken before the answer is printed: the lease gives it back
   * only if the hook never printed in time, and what the command voids ends once it was.
   */
  private async confirmed(
    terminalId: string,
    call: GateCall,
    until: number,
  ): Promise<GateAnswer | undefined> {
    const now = Date.now()
    const live = (this.vetted.get(terminalId) ?? []).filter((each) => each.until > now)
    const note = live.find(
      (each) =>
        call.call !== undefined &&
        each.call === call.call &&
        each.conversation === call.conversation,
    )
    this.vetted.set(
      terminalId,
      live.filter((each) => each !== note),
    )
    if (!note || note.command !== call.command) return undefined
    try {
      const covered = await within(
        this.gate.covered(terminalId, note.command, note.cwd),
        until - Date.now(),
      )
      if (!covered) return undefined
      covered.take()
      const leaseId = randomUUID()
      const timer = setTimeout(
        () => {
          if (this.leases.delete(leaseId)) covered.restore()
        },
        Math.max(0, until + ackSlackMs - Date.now()),
      )
      timer.unref()
      this.leases.set(leaseId, {
        terminalId,
        commit: covered.voided,
        expires: until + ackSlackMs,
        timer,
      })
      log.info(
        "shipping.confirmation",
        `Novadeck answers opencode's permission: ${covered.permits
          .map((permit) => `${describeKey(permit.key)} (${describeSource(permit.source)})`)
          .join("; ")}`,
        {
          data: {
            terminalId,
            agent: "opencode",
            call: call.call ?? null,
            at: new Date().toISOString(),
          },
        },
      )
      return { stdout: `${JSON.stringify({ reply: "once" })}\n`, leaseId }
    } catch {
      return undefined
    }
  }

  /** The hook printed what a lease delivered: its effect happens, if it was in time. */
  acknowledged(terminalId: string, leaseId: string): void {
    const lease = this.leases.get(leaseId)
    if (lease?.terminalId !== terminalId) return
    this.leases.delete(leaseId)
    clearTimeout(lease.timer)
    if (lease.expires > Date.now()) lease.commit()
  }

  /** A terminal closed: its permits and quotes go. */
  closed(terminalId: string): void {
    this.permits.forget(terminalId)
    this.quotes.forget(terminalId)
    this.cards.forget(terminalId)
    this.modes.delete(terminalId)
    this.pending.delete(terminalId)
    this.vetted.delete(terminalId)
    this.hooked.delete(terminalId)
    for (const key of this.looked) if (key.startsWith(`${terminalId}\n`)) this.looked.delete(key)
  }
}
