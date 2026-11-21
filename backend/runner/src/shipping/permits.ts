/**
 * The shipping gate's permits and the ring of what the person typed (see
 * architecture/grants.md). Both live in memory, per terminal: a restart fails closed, and a
 * command then needs a permit again.
 */

/** How long a permit lasts: the same target gets retried (a failed push), and Codex asks twice. */
export const permitMs = 10 * 60_000

/** What gave a permit. */
export type Source =
  | { readonly type: "quote"; readonly quote: string }
  | { readonly type: "answer"; readonly card: string }

export type Permit = {
  readonly terminalId: string
  readonly key: string
  readonly until: number
  /** A force or `--admin` permit is used once. */
  readonly singleUse: boolean
  readonly source: Source
}

/** The permits of every terminal, each for one target, kept ten minutes. */
export class Permits {
  private readonly held = new Map<string, Permit>()
  private readonly listeners = new Set<(permit: Permit) => void>()

  constructor(private readonly now: () => number = Date.now) {}

  private id(terminalId: string, key: string): string {
    return `${terminalId}\n${key}`
  }

  /** Gives a terminal the permit for `key`, replacing one it held. */
  give(terminalId: string, key: string, singleUse: boolean, source: Source): Permit {
    const permit = { terminalId, key, until: this.now() + permitMs, singleUse, source }
    this.held.set(this.id(terminalId, key), permit)
    for (const listener of this.listeners) listener(permit)
    return permit
  }

  /** The live permit of a terminal for `key`, if it holds one. */
  covering(terminalId: string, key: string): Permit | undefined {
    const permit = this.held.get(this.id(terminalId, key))
    if (!permit) return undefined
    if (permit.until <= this.now()) {
      this.held.delete(this.id(terminalId, key))
      return undefined
    }
    return permit
  }

  /** A permit was used: a single-use one ends. */
  used(permit: Permit): void {
    if (permit.singleUse) this.held.delete(this.id(permit.terminalId, permit.key))
  }

  /** Ends every permit of a terminal, as it closes. */
  forget(terminalId: string): void {
    for (const [id, permit] of this.held) if (permit.terminalId === terminalId) this.held.delete(id)
  }

  /** Calls `listener` whenever a permit is given, to withdraw a card another source answered. */
  onGiven(listener: (permit: Permit) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** How many of the person's prompts the ring keeps, and for how long. */
export const ringPrompts = 3
export const ringMs = 60 * 60_000

const words = (text: string): string => text.replaceAll(/\s+/g, " ").trim().toLowerCase()

/** The shortest quote that counts: a few letters could be found in any prompt. */
const shortest = 4

/**
 * What the person typed into each terminal's agent: the last few prompts, none older than an
 * hour, per root session, so a `/clear` (a new session) starts it empty. Only the person's real
 * typing goes in: the caller records a root turn the person began, never a doorbell, a delivery
 * or a command line an agent was started with.
 */
export class Quotes {
  private readonly rings = new Map<
    string,
    { sessionId: string; prompts: { at: number; text: string }[] }
  >()

  constructor(private readonly now: () => number = Date.now) {}

  /** Notes a prompt the person typed into `terminalId`'s root session. */
  record(terminalId: string, sessionId: string, text: string): void {
    const ring = this.rings.get(terminalId)
    const prompts = ring?.sessionId === sessionId ? ring.prompts : []
    // The same turn reported twice (a hook and a transcript) is one prompt.
    if (prompts.at(-1)?.text === text) return
    prompts.push({ at: this.now(), text })
    this.rings.set(terminalId, { sessionId, prompts: prompts.slice(-ringPrompts) })
  }

  /** The prompts still in the ring, oldest first. */
  prompts(terminalId: string): readonly string[] {
    const cutoff = this.now() - ringMs
    return (this.rings.get(terminalId)?.prompts ?? [])
      .filter((prompt) => prompt.at > cutoff)
      .map((prompt) => prompt.text)
  }

  /**
   * Whether `said`, word for word (whitespace and case aside), is in a prompt the person typed
   * into this terminal. Novadeck checks that they said it; the agent judges what it means.
   */
  said(terminalId: string, said: string): boolean {
    const quote = words(said)
    if (quote.length < shortest) return false
    return this.prompts(terminalId).some((prompt) => words(prompt).includes(quote))
  }

  forget(terminalId: string): void {
    this.rings.delete(terminalId)
  }
}
