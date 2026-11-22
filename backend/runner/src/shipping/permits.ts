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
  | { readonly type: "answer"; readonly card: string; readonly client?: string }

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

  /** Ends every terminal's permit for `key`: the target it was given for has changed. */
  revoke(key: string): void {
    for (const [id, permit] of this.held) if (permit.key === key) this.held.delete(id)
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

/** The fewest words a quote may have: one or two letters could be found in any prompt. */
export const quoteWords = 2

// A word is a run of letters or digits; punctuation and spacing between words don't count.
const wordsOf = (text: string): { word: string; start: number; end: number }[] =>
  [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    word: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }))

/**
 * What of `prompt` `quote` is, if it is in it: at least `quoteWords` whole words, in a row, in
 * the same order, found at word boundaries with case and spacing aside. The prompt's own
 * wording of them (its slice, as the person wrote it) comes back, never the agent's.
 */
export const quotedIn = (prompt: string, quote: string): string | undefined => {
  const wanted = wordsOf(quote).map((each) => each.word)
  if (wanted.length < quoteWords) return undefined
  const have = wordsOf(prompt)
  for (let at = 0; at + wanted.length <= have.length; at += 1)
    if (wanted.every((word, index) => have[at + index]!.word === word))
      return prompt.slice(have[at]!.start, have[at + wanted.length - 1]!.end)
  return undefined
}

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
   * What the person typed that `said` quotes, word for word (see `quotedIn`), in the prompts of
   * this terminal; undefined where they didn't say it. Novadeck checks that they said it; the
   * agent judges what it means.
   */
  said(terminalId: string, said: string): string | undefined {
    for (const prompt of this.prompts(terminalId).toReversed()) {
      const found = quotedIn(prompt, said)
      if (found !== undefined) return found
    }
    return undefined
  }

  forget(terminalId: string): void {
    this.rings.delete(terminalId)
  }
}
