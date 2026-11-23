/**
 * The action cards of the shipping gate (see architecture/grants.md): a Novadeck-held request
 * that asks the person whether an agent may ship, with Allow and Deny, answered in place in the
 * chat and the Inbox. A card is drawn only from fields Novadeck resolved (the action in plain
 * words, from git and gh), never from text an agent wrote. One is open per (terminal, action,
 * target), and it is withdrawn when another source gives the permit.
 */
import { randomUUID } from "node:crypto"

export type Card = {
  readonly id: string
  readonly terminalId: string
  /** The permit keys that Allow gives (a PR merge also by its branch). */
  readonly keys: readonly string[]
  readonly singleUse: boolean
  /** The question, in plain words: "Merge PR #1170 into main?". */
  readonly title: string
  /** What Novadeck went by, in lines. */
  readonly detail: string
  readonly askedAt: number
  /** The agent session that asked: a card stands for that session only, as a permit does. */
  readonly sessionId: string | null
}

export type CardsOptions = {
  /**
   * The agent session bound in a terminal now: a card another session asked, as before a
   * `/clear` or another agent started there, or with no agent left, is closed. Without it,
   * sessions aren't told.
   */
  readonly session?: (terminalId: string) => string | undefined
}

export class Cards {
  private readonly open = new Map<string, Card>()
  private readonly listeners = new Set<(terminalId: string) => void>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: CardsOptions = {},
  ) {}

  // Whether a card still stands: for the session bound now.
  private stands(card: Card): boolean {
    if (!this.options.session) return true
    return (this.options.session(card.terminalId) ?? null) === card.sessionId
  }

  /**
   * Closes the terminal's cards another session asked, telling `watch` once the caller's own
   * work is done (a read may come while a terminal's summary is being drawn).
   */
  private sweep(terminalId: string): void {
    let ended = false
    for (const [id, card] of this.open)
      if (card.terminalId === terminalId && !this.stands(card)) {
        this.open.delete(id)
        ended = true
      }
    if (ended) queueMicrotask(() => this.changed(terminalId))
  }

  /** Calls `listener` with the terminal whose open cards changed. */
  watch(listener: (terminalId: string) => void): void {
    this.listeners.add(listener)
  }

  private changed(terminalId: string): void {
    for (const listener of this.listeners) listener(terminalId)
  }

  /** The terminal's open cards, oldest first. */
  of(terminalId: string): readonly Card[] {
    this.sweep(terminalId)
    return [...this.open.values()].filter((card) => card.terminalId === terminalId)
  }

  find(terminalId: string, id: string): Card | undefined {
    return this.of(terminalId).find((card) => card.id === id)
  }

  /** The card for this terminal and target, if one is open. */
  covering(terminalId: string, key: string): Card | undefined {
    return this.of(terminalId).find((card) => card.keys.includes(key))
  }

  /** Opens a card, or returns the one already open for the same terminal and target. */
  ask(
    terminalId: string,
    keys: readonly string[],
    singleUse: boolean,
    title: string,
    detail: string,
  ): { readonly card: Card; readonly fresh: boolean } {
    const existing = this.covering(terminalId, keys[0]!)
    if (existing) return { card: existing, fresh: false }
    const card = {
      id: randomUUID(),
      terminalId,
      keys,
      singleUse,
      title,
      detail,
      askedAt: this.now(),
      sessionId: this.options.session?.(terminalId) ?? null,
    }
    this.open.set(card.id, card)
    this.changed(terminalId)
    return { card, fresh: true }
  }

  /** Takes a card away: answered, or its permit given another way. */
  close(card: Card): void {
    if (this.open.delete(card.id)) this.changed(card.terminalId)
  }

  /** The terminal closed. */
  forget(terminalId: string): void {
    const gone = this.of(terminalId)
    for (const card of gone) this.open.delete(card.id)
    if (gone.length > 0) this.changed(terminalId)
  }
}
