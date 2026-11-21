/**
 * The shipping gate as the runner holds it (see architecture/grants.md): its permits and the
 * ring of what the person typed, the decision, and the switch that turns it on. Everything is
 * in memory per terminal, so a restart fails closed.
 */
import { open } from "node:fs/promises"

import type { AgentName } from "@novadeck/protocol"

import { noticeText } from "../messaging/notice-format.js"
import type { GateCall } from "../shell/hook.js"
import type { Record } from "../terminals/record.js"
import { Cards, type Card } from "./cards.js"
import { declare, ghPull, type Declared, type DeclareAnswer } from "./declare.js"
import { describeKey, Gate, type Turn } from "./gate.js"
import { gitLookups, type Owned } from "./lookups.js"
import { Permits, Quotes } from "./permits.js"
import { claudeRules, codexRules } from "./rules.js"

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

export class Shipping {
  readonly permits = new Permits()
  readonly quotes = new Quotes()
  readonly cards = new Cards()
  private readonly gate: Gate

  constructor(private readonly host: ShippingHost) {
    this.gate = new Gate({
      lookups: (terminalId) => gitLookups(terminalId, host.owned),
      permits: this.permits,
      rules: (agent, cwd) => (agent === "claude" ? claudeRules(cwd) : codexRules()),
      turn: turnOf,
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
  answered(card: Card, allow: boolean): void {
    this.cards.close(card)
    if (allow)
      for (const key of card.keys)
        this.permits.give(card.terminalId, key, card.singleUse, { type: "answer", card: card.id })
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

  /** Whether the gate answers `agent`'s `event`: Claude's PreToolUse, Codex's PreToolUse and PermissionRequest. */
  gating(agent: AgentName, event: string): boolean {
    if (!this.host.enabled()) return false
    if (agent === "claude") return event === "PreToolUse"
    return agent === "codex" && (event === "PreToolUse" || event === "PermissionRequest")
  }

  /**
   * What the hook of `agent` in `terminalId` prints for a shell command, or undefined for no
   * opinion. A failure is no opinion, never an allow.
   */
  async answer(terminalId: string, agent: AgentName, call: GateCall): Promise<string | undefined> {
    if (!this.gating(agent, call.event) || (agent !== "claude" && agent !== "codex"))
      return undefined
    try {
      return await this.gate.decide({
        agent,
        event: call.event,
        terminalId,
        command: call.command,
        cwd: call.cwd,
        ...(call.mode !== undefined && { mode: call.mode }),
        ...(call.transcript !== undefined && { transcript: call.transcript }),
      })
    } catch {
      return undefined
    }
  }

  /** A terminal closed: its permits and quotes go. */
  closed(terminalId: string): void {
    this.permits.forget(terminalId)
    this.quotes.forget(terminalId)
    this.cards.forget(terminalId)
  }
}
