/**
 * The shipping gate as the runner holds it (see architecture/grants.md): its permits and the
 * ring of what the person typed, the decision, and the switch that turns it on. Everything is
 * in memory per terminal, so a restart fails closed.
 */
import { open } from "node:fs/promises"

import type { AgentName } from "@novadeck/protocol"

import type { GateCall } from "../shell/hook.js"
import { Gate, type Turn } from "./gate.js"
import { gitLookups, type Owned } from "./lookups.js"
import { Permits, Quotes } from "./permits.js"
import { claudeRules, codexRules } from "./rules.js"

/** What the gate needs of the rest of the runner. */
export type ShippingHost = {
  /** Whether the Experimental shipping gate is on, read each time a hook comes. */
  readonly enabled: () => boolean
  readonly owned: Owned
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
  private readonly gate: Gate

  constructor(private readonly host: ShippingHost) {
    this.gate = new Gate({
      lookups: (terminalId) => gitLookups(terminalId, host.owned),
      permits: this.permits,
      rules: (agent, cwd) => (agent === "claude" ? claudeRules(cwd) : codexRules()),
      turn: turnOf,
    })
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
  }
}
