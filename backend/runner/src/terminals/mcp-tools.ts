import { logs } from "../log.js"

const log = logs.for("doorbell")

export type McpToolsOptions = {
  readonly now?: () => number
  /**
   * How long a ring waits at most for an agent's MCP session to list Novadeck's tools, in
   * milliseconds: past it, it rings without them rather than not at all. 0 waits not at all.
   */
  readonly waitMs?: number
}

/**
 * Which terminals' agents have Novadeck's MCP tools: a terminal holds them while an MCP
 * session there has had its listing of them answered and is still open (the agent's, or a
 * nested run's). The doorbell asks how long to wait for them before it rings an agent that
 * takes its tools only as a turn starts (`MessagingProfile.toolsAtTurnStart`): once per
 * terminal at most `waitMs`, then it rings without them, said once in the log, and doesn't
 * wait again there until a session lists them.
 */
export class McpTools {
  private readonly now: () => number
  private readonly waitMs: number
  /** The sessions open in each terminal that listed the tools. */
  private readonly listed = new Map<string, number>()
  /** When each terminal's wait for its tools began. */
  private readonly waiting = new Map<string, number>()
  /** The terminals whose wait ran out, which aren't waited for again. */
  private readonly overdue = new Set<string>()

  constructor(options: McpToolsOptions = {}) {
    this.now = options.now ?? Date.now
    this.waitMs = options.waitMs ?? 10_000
  }

  /**
   * An MCP session in the terminal listed the tools (`listed`), or closed after that; true
   * when the terminal holds the tools now and didn't before.
   */
  session(terminalId: string, listed: boolean): boolean {
    const open = (this.listed.get(terminalId) ?? 0) + (listed ? 1 : -1)
    if (open > 0) this.listed.set(terminalId, open)
    else this.listed.delete(terminalId)
    if (!listed || open !== 1) return false
    this.waiting.delete(terminalId)
    this.overdue.delete(terminalId)
    return true
  }

  /** How much longer a ring waits for the terminal's agent to hold the tools, in milliseconds. */
  wait(terminalId: string): number {
    if (this.waitMs === 0 || this.listed.has(terminalId) || this.overdue.has(terminalId)) return 0
    const now = this.now()
    const since = this.waiting.get(terminalId) ?? now
    this.waiting.set(terminalId, since)
    const left = since + this.waitMs - now
    if (left > 0) return left
    this.waiting.delete(terminalId)
    this.overdue.add(terminalId)
    log.warn(
      "doorbell.tools-late",
      "Novadeck's MCP server hadn't listed its tools to the agent; ringing it without them",
      { data: { terminalId, waitedMs: now - since } },
    )
    return 0
  }

  /** Forgets a terminal that exited or went. */
  forget(terminalId: string): void {
    this.listed.delete(terminalId)
    this.waiting.delete(terminalId)
    this.overdue.delete(terminalId)
  }
}
