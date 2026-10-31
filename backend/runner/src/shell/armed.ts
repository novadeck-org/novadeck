import { createHash } from "node:crypto"

/** How long an armed command waits for its identical retry: the person's time to see it. */
export const armedMs = 10 * 60_000

// Per terminal; a terminal that is refused more than this in ten minutes has its oldest forgotten.
const perTerminal = 16

/**
 * The commands Claude Code's auto mode refused (its PermissionDenied hook), each armed for
 * its terminal: the next identical Bash call, if no grant covers it, is answered `ask`, which
 * opens Claude Code's own dialog without the classifier (approvals-design.md, "How a grant is
 * made", B). Once, for ten minutes. A command is kept as its hash, not its text.
 */
export class Armed {
  private readonly arms = new Map<string, Map<string, number>>()

  private static key(command: string): string {
    return createHash("sha256").update(command).digest("hex")
  }

  /** Arms `command` for the terminal until `now` + ten minutes. */
  arm(terminalId: string, command: string, now: number): void {
    const own = this.arms.get(terminalId) ?? new Map<string, number>()
    for (const [key, until] of own) if (until <= now) own.delete(key)
    const key = Armed.key(command)
    own.delete(key)
    own.set(key, now + armedMs)
    while (own.size > perTerminal) own.delete(own.keys().next().value as string)
    this.arms.set(terminalId, own)
  }

  /** Whether `command` is armed for the terminal, and not for another try: it is used up. */
  take(terminalId: string, command: string, now: number): boolean {
    const own = this.arms.get(terminalId)
    if (!own) return false
    const key = Armed.key(command)
    const until = own.get(key)
    if (until === undefined) return false
    own.delete(key)
    if (own.size === 0) this.arms.delete(terminalId)
    return until > now
  }

  /** Forgets every arm of a terminal, as it closes. */
  forget(terminalId: string): void {
    this.arms.delete(terminalId)
  }
}
