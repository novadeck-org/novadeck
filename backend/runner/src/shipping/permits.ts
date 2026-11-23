/**
 * The shipping gate's permits and the ring of what the person typed (see
 * architecture/grants.md). Both live in memory, per terminal: a restart fails closed, and a
 * command then needs a permit again.
 */
import { randomUUID } from "node:crypto"

/**
 * How long a permit lasts once used: the same target gets retried (a failed push), and Codex
 * asks twice for one run.
 */
export const permitMs = 10 * 60_000

/**
 * How long a permit stands unused: a go-ahead given at bedtime covers the merge once CI is
 * green, hours later. Its first use, its PR closing, its terminal closing, a restart, or the
 * person taking it back ends it sooner.
 */
export const standingMs = 12 * 60 * 60_000

/** What gave a permit. */
export type Source =
  | { readonly type: "quote"; readonly quote: string }
  | { readonly type: "answer"; readonly card: string; readonly client?: string }

export type Permit = {
  readonly terminalId: string
  readonly key: string
  /**
   * The permits one declaration or one card gave together (a PR's merge by its number and by
   * its branch): used, shown, voided and taken back as one.
   */
  readonly group: string
  /** What it permits, in Novadeck's own words: "Merge PR #1170 into main". */
  readonly title: string
  /** The agent session it was given in: a permit stands for that session only. */
  readonly sessionId: string | null
  readonly givenAt: number
  readonly until: number
  /** When it was first used; its retry window runs from there. */
  readonly usedAt: number | null
  /** A force or `--admin` permit is used once. */
  readonly singleUse: boolean
  readonly source: Source
}

/** What a permit stands for, as one declaration or card gave it. */
export type Given = { readonly group?: string; readonly title?: string }

export type PermitsOptions = {
  /**
   * The agent session bound in a terminal now: a permit given in another one, as before a
   * `/clear` or another agent started there, no longer stands. Without it, sessions aren't told.
   */
  readonly session?: (terminalId: string) => string | undefined
}

/**
 * The permits of every terminal, each for one target, standing until used or `standingMs`, for
 * the agent session they were given in. Whatever ends one, its clock included, tells `watch`.
 */
export class Permits {
  private readonly held = new Map<string, Permit>()
  // Counts what ended permits other than their use: a revoke, a take back, a terminal's close.
  private epoch = 0
  private readonly listeners = new Set<(permit: Permit) => void>()
  private readonly changes = new Set<(terminalId: string) => void>()
  // Ends the permits whose time is up when it comes, so their end is told, not only found.
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: PermitsOptions = {},
  ) {}

  private id(terminalId: string, key: string): string {
    return `${terminalId}\n${key}`
  }

  private changed(terminalIds: Iterable<string>): void {
    for (const terminalId of new Set(terminalIds))
      for (const listener of this.changes) listener(terminalId)
    this.schedule()
  }

  // Whether a permit still stands: within its time, and no other session is bound in its
  // terminal. With none bound, as while its agent is suspended (Ctrl+Z) or its harness
  // disconnects, it waits for the session to come back; another one ends it.
  private stands(permit: Permit, now: number): boolean {
    if (permit.until <= now) return false
    const session = this.options.session?.(permit.terminalId)
    return session === undefined || session === permit.sessionId
  }

  // Whether a permit covers a command now: it stands, and its own session is the one bound.
  private usable(permit: Permit): boolean {
    if (!this.options.session) return true
    return (this.options.session(permit.terminalId) ?? null) === permit.sessionId
  }

  /**
   * Ends what no longer stands, telling `watch` once the caller's own work is done (a read may
   * come while a terminal's detail is being drawn).
   */
  private sweep(): void {
    const now = this.now()
    const ended: string[] = []
    for (const [id, permit] of this.held)
      if (!this.stands(permit, now)) {
        this.held.delete(id)
        ended.push(permit.terminalId)
      }
    if (ended.length > 0) queueMicrotask(() => this.changed(ended))
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const next = Math.min(...[...this.held.values()].map((permit) => permit.until))
    if (!Number.isFinite(next)) return
    this.timer = setTimeout(() => this.sweep(), Math.max(0, next - this.now()) + 1)
    this.timer.unref?.()
  }

  /** Gives a terminal the permit for `key`, replacing one it held. */
  give(
    terminalId: string,
    key: string,
    singleUse: boolean,
    source: Source,
    given: Given = {},
  ): Permit {
    const at = this.now()
    const permit: Permit = {
      terminalId,
      key,
      group: given.group ?? randomUUID(),
      title: given.title ?? key,
      sessionId: this.options.session?.(terminalId) ?? null,
      givenAt: at,
      until: at + standingMs,
      usedAt: null,
      singleUse,
      source,
    }
    this.held.set(this.id(terminalId, key), permit)
    for (const listener of this.listeners) listener(permit)
    this.changed([terminalId])
    return permit
  }

  /** The live permit of a terminal for `key`, if it holds one. */
  covering(terminalId: string, key: string): Permit | undefined {
    const permit = this.held.get(this.id(terminalId, key))
    if (!permit) return undefined
    if (!this.stands(permit, this.now())) {
      this.sweep()
      return undefined
    }
    return this.usable(permit) ? permit : undefined
  }

  /** The terminal's live permits, oldest first. */
  of(terminalId: string): readonly Permit[] {
    this.sweep()
    return [...this.held.values()]
      .filter((permit) => permit.terminalId === terminalId)
      .toSorted((one, other) => one.givenAt - other.givenAt)
  }

  /**
   * A permit was used: a single-use one ends, and a standing one, with the others of its
   * group, keeps only its retry window from its first use.
   */
  used(permit: Permit): void {
    if (permit.singleUse) {
      // One use ends every target the same declaration gave (a PR by number and by branch).
      let ended = false
      for (const [id, each] of this.held)
        if (each.terminalId === permit.terminalId && each.group === permit.group) {
          this.held.delete(id)
          ended = true
        }
      if (ended) this.changed([permit.terminalId])
      return
    }
    const at = this.now()
    let touched = false
    for (const [id, each] of this.held)
      if (
        each.terminalId === permit.terminalId &&
        each.group === permit.group &&
        each.usedAt === null
      ) {
        this.held.set(id, { ...each, usedAt: at, until: Math.min(each.until, at + permitMs) })
        touched = true
      }
    if (touched) this.changed([permit.terminalId])
  }

  /**
   * Takes a single-use permit now (a standing one is left, and gives nothing back): the returned
   * `restore` puts it back only if nothing ended permits since, as a revoke or a terminal's close
   * does, so what `revoke` ended never comes back.
   */
  take(permit: Permit): (() => void) | undefined {
    if (!permit.singleUse) return undefined
    const id = this.id(permit.terminalId, permit.key)
    if (this.held.get(id) !== permit) return undefined
    const taken = [...this.held].filter(
      ([, each]) => each.terminalId === permit.terminalId && each.group === permit.group,
    )
    for (const [each] of taken) this.held.delete(each)
    const epoch = this.epoch
    return () => {
      for (const [each, held] of taken)
        if (this.epoch === epoch && this.stands(held, this.now()) && !this.held.has(each))
          this.held.set(each, held)
    }
  }

  /**
   * Ends the permits `ends` picks, with every other of their groups; whether any stood. `always`
   * counts it as an end even where none stood here, as a single-use permit taken for a dialog
   * (out of the map) mustn't come back after its target changed or its terminal closed.
   */
  private end(ends: (permit: Permit) => boolean, always = false): boolean {
    if (always) this.epoch += 1
    const groups = new Set(
      [...this.held.values()]
        .filter(ends)
        .map(({ terminalId, group }) => `${terminalId}\n${group}`),
    )
    const ended: string[] = []
    for (const [id, permit] of this.held)
      if (groups.has(`${permit.terminalId}\n${permit.group}`)) {
        this.held.delete(id)
        ended.push(permit.terminalId)
      }
    if (ended.length === 0) return false
    if (!always) this.epoch += 1
    this.changed(ended)
    return true
  }

  /**
   * Ends every terminal's permit for `key`, and the others its declaration gave with it: the
   * target it was given for has changed, as a PR's base.
   */
  revoke(key: string): void {
    this.end((permit) => permit.key === key, true)
  }

  /** Ends a terminal's permits of one group: the person took them back. Whether any stood. */
  takeBack(terminalId: string, group: string): boolean {
    return this.end((permit) => permit.terminalId === terminalId && permit.group === group)
  }

  /** Ends every permit of a terminal, as it closes. */
  forget(terminalId: string): void {
    this.end((permit) => permit.terminalId === terminalId, true)
  }

  /** Ends every permit, as the gate is switched off: switched on again, none comes back. */
  clear(): void {
    this.end(() => true, true)
  }

  /** Calls `listener` whenever a permit is given, to withdraw a card another source answered. */
  onGiven(listener: (permit: Permit) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Calls `listener` with the terminal whose permits changed: given, used, ended. */
  watch(listener: (terminalId: string) => void): () => void {
    this.changes.add(listener)
    return () => this.changes.delete(listener)
  }
}

/**
 * How long the ring keeps what the person typed, however many prompts came after: words count
 * while they are fresh. The count only bounds the memory a chatty hour takes.
 */
export const ringMs = 60 * 60_000
export const ringPrompts = 200

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
 * What the person typed into each terminal's agent: every prompt of the last hour, per root
 * session, so a `/clear` (a new session) starts it empty. Only the person's real
 * typing goes in: the caller records a root turn the person began, never a doorbell, a delivery
 * or a command line an agent was started with.
 *
 * A prompt that answered one of the agent's open asks is a reply, which `said` takes whole at any
 * length. Each prompt is kept with when the person submitted it, so a decline can tell the
 * prompts before it from those after (`Declines`), however late a prompt was reported.
 */
export class Quotes {
  private readonly rings = new Map<
    string,
    {
      sessionId: string
      prompts: { at: number; text: string; reply: boolean; turn?: number }[]
    }
  >()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Notes a prompt the person typed into `terminalId`'s root session, submitted at `at` (now when
   * left out); `reply` where it answered an ask. `turn` names the turn it started: the same turn
   * reported twice (a hook and a transcript) is one prompt, while the same words typed again are
   * another.
   */
  record(
    terminalId: string,
    sessionId: string,
    text: string,
    reply = false,
    at: number = this.now(),
    turn?: number,
  ): void {
    const ring = this.rings.get(terminalId)
    const prompts = ring?.sessionId === sessionId ? ring.prompts : []
    const same =
      turn === undefined
        ? undefined
        : prompts.find((prompt) => prompt.turn === turn && prompt.text === text)
    if (same) {
      if (reply) same.reply = true
      return
    }
    prompts.push({ at, text, reply, ...(turn !== undefined && { turn }) })
    this.rings.set(terminalId, { sessionId, prompts: prompts.slice(-ringPrompts) })
  }

  /** The time a decline made now is held at: only prompts submitted after it are after it. */
  mark(): number {
    return this.now()
  }

  /** Whether the person submitted a prompt into `terminalId` after `mark`. */
  typedSince(terminalId: string, mark: number): boolean {
    return (this.rings.get(terminalId)?.prompts ?? []).some((prompt) => prompt.at > mark)
  }

  /** The prompts still in the ring, oldest first. */
  prompts(terminalId: string): readonly string[] {
    return this.fresh(terminalId).map((prompt) => prompt.text)
  }

  private fresh(terminalId: string, since = Number.NEGATIVE_INFINITY) {
    const cutoff = this.now() - ringMs
    return (this.rings.get(terminalId)?.prompts ?? []).filter(
      (prompt) => prompt.at > cutoff && prompt.at > since,
    )
  }

  /**
   * What the person typed that `said` quotes, word for word (see `quotedIn`), in the prompts of
   * this terminal; or, for a reply to an ask, the whole reply, whatever its length. Undefined
   * where they didn't say it. Only prompts after `since` count. Novadeck checks that they said
   * it; the agent judges what it means.
   */
  said(terminalId: string, said: string, since = Number.NEGATIVE_INFINITY): string | undefined {
    const wanted = wordsOf(said).map((each) => each.word)
    for (const prompt of this.fresh(terminalId, since).toReversed()) {
      if (prompt.reply && wanted.length > 0) {
        const have = wordsOf(prompt.text).map((each) => each.word)
        if (have.length === wanted.length && have.every((word, at) => word === wanted[at]))
          return prompt.text
      }
      const found = quotedIn(prompt.text, said)
      if (found !== undefined) return found
    }
    return undefined
  }

  forget(terminalId: string): void {
    this.rings.delete(terminalId)
  }
}

/**
 * The actions and targets the person declined (a Deny on a card, a Take back), per terminal and
 * agent session, in memory like permits. A declined key answers "declined" until the person next
 * types in that terminal; after that it asks as usual, but only words typed after the decline
 * can give its permit (`since`). It ends with the agent session, the terminal's close, the gate
 * switched off and a restart.
 */
export class Declines {
  private readonly held = new Map<
    string,
    { sessionId: string | null; marks: Map<string, number> }
  >()

  constructor(
    private readonly quotes: Quotes,
    private readonly session: (terminalId: string) => string | undefined = () => undefined,
  ) {}

  // The terminal's declines, none once another session is bound there (none bound: they wait).
  private live(terminalId: string): Map<string, number> | undefined {
    const held = this.held.get(terminalId)
    if (!held) return undefined
    const session = this.session(terminalId)
    if (session !== undefined && session !== held.sessionId) {
      this.held.delete(terminalId)
      return undefined
    }
    return held.marks
  }

  /** The person declined these keys now. */
  decline(terminalId: string, keys: readonly string[]): void {
    const held = this.live(terminalId) ?? new Map<string, number>()
    const mark = this.quotes.mark()
    for (const key of keys) held.set(key, mark)
    this.held.set(terminalId, {
      sessionId: this.session(terminalId) ?? null,
      marks: held,
    })
  }

  /** Whether `key` is declined and the person hasn't typed in the terminal since. */
  declined(terminalId: string, key: string): boolean {
    const mark = this.live(terminalId)?.get(key)
    return mark !== undefined && !this.quotes.typedSince(terminalId, mark)
  }

  /** The time before which the person's words never give any of `keys` a permit again; minus infinity for none. */
  since(terminalId: string, keys: readonly string[]): number {
    const marks = this.live(terminalId)
    return Math.max(
      Number.NEGATIVE_INFINITY,
      ...keys.map((key) => marks?.get(key) ?? Number.NEGATIVE_INFINITY),
    )
  }

  forget(terminalId: string): void {
    this.held.delete(terminalId)
  }

  clear(): void {
    this.held.clear()
  }
}
