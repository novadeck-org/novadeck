/**
 * The shipping gate as the runner holds it (see architecture/grants.md): its permits and the
 * ring of what the person typed, the decision, and the switch that turns it on. Everything is
 * in memory per terminal, so a restart fails closed.
 */
import { randomUUID } from "node:crypto"
import { open } from "node:fs/promises"

import type { AgentName } from "@novadeck/protocol"

import { logs } from "../log.js"
import { noticeText } from "../messaging/notice-format.js"
import type { GateCall } from "../shell/hook.js"
import type { Record } from "../terminals/record.js"
import { Cards, type Card } from "./cards.js"
import { declare, ghDefault, ghPull, type Declared, type DeclareAnswer } from "./declare.js"
import { describeKey, describeSource, Gate, type Turn } from "./gate.js"
import { defaultOf, gitLookups, validName, type Owned } from "./lookups.js"
import { Permits, Quotes } from "./permits.js"
import { agyRules, claudeRules, codexRules } from "./rules.js"

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

export class Shipping {
  readonly permits = new Permits()
  readonly quotes = new Quotes()
  readonly cards = new Cards()
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
      rules: (agent, cwd) =>
        agent === "claude" ? claudeRules(cwd) : agent === "codex" ? codexRules() : agyRules(),
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

  private agentOf(terminalId: string): "claude" | "codex" | "agy" | undefined {
    return this.records.get(terminalId)?.bound?.binding.agent
  }

  /** Whether the gate is on. */
  enabled(): boolean {
    return this.host.enabled()
  }

  /** Whether the gate is on and covers `agent`'s harness: all three. */
  covers(agent: AgentName): boolean {
    return this.host.enabled() && (agent === "claude" || agent === "codex" || agent === "agy")
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

  // The mode each Antigravity terminal's status line last said (`cycle_mode`: `plan` or
  // `accept-edits`, none in `auto`), by terminal.
  private readonly modes = new Map<string, string | null>()

  /** An Antigravity status line came: the mode it names, or none (its default, `auto`). */
  statusLine(terminalId: string, payload: { readonly [key: string]: unknown }): void {
    const mode = payload.cycle_mode
    this.modes.set(terminalId, typeof mode === "string" ? mode : null)
  }

  /**
   * The mode an Antigravity terminal runs in: its status line's latest, which follows a Shift+Tab
   * switch, else the launch's `--mode`, else its default, `auto`.
   */
  agyMode(terminalId: string, launch: readonly string[] | undefined): string {
    const live = this.modes.get(terminalId)
    if (live !== undefined) return live ?? "auto"
    return launchMode(launch) ?? "auto"
  }

  /**
   * What to type into Antigravity's own confirmation of a command, as the person would: the run
   * once option, only where a live permit covers that very command, read as the gate reads it for
   * Claude Code, and the dialog shows it whole. Undefined (the person answers) in any doubt.
   * Antigravity shows the confirmation only where it asks, so the mode needs no look here.
   */
  async autoAnswer(
    terminalId: string,
    agent: AgentName,
    command: string,
    cwd: string,
  ): Promise<{ readonly note: string; readonly used: () => void } | undefined> {
    if (!this.covers(agent) || agent !== "agy") return undefined
    try {
      const covered = await this.gate.covered(terminalId, command, cwd)
      if (!covered) return undefined
      return {
        used: covered.used,
        note: covered.permits
          .map((permit) => `${describeKey(permit.key)} (${describeSource(permit.source)})`)
          .join("; "),
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
    let decision
    try {
      decision = await within(
        this.gate.decide({
          agent,
          event: call.event,
          terminalId,
          command: call.command,
          cwd: call.cwd,
          ...(agent === "agy"
            ? { mode: this.agyMode(terminalId, call.launch) }
            : call.mode !== undefined && { mode: call.mode }),
          ...(call.transcript !== undefined && { transcript: call.transcript }),
        }),
        until - Date.now(),
      )
    } catch {
      return undefined
    }
    if (decision === undefined) return undefined
    const { stdout, commit } = decision
    if (commit === undefined) return stdout === "" ? undefined : { stdout, leaseId: null }
    const now = Date.now()
    for (const [id, lease] of this.leases) if (lease.expires <= now) this.leases.delete(id)
    const leaseId = randomUUID()
    this.leases.set(leaseId, { terminalId, commit, expires: until + ackSlackMs })
    return { stdout, leaseId }
  }

  /** The hook printed what a lease delivered: its effect happens, if it was in time. */
  acknowledged(terminalId: string, leaseId: string): void {
    const lease = this.leases.get(leaseId)
    if (lease?.terminalId !== terminalId) return
    this.leases.delete(leaseId)
    if (lease.expires > Date.now()) lease.commit()
  }

  /** A terminal closed: its permits and quotes go. */
  closed(terminalId: string): void {
    this.permits.forget(terminalId)
    this.quotes.forget(terminalId)
    this.cards.forget(terminalId)
    this.modes.delete(terminalId)
  }
}
