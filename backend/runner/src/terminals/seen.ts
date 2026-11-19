/**
 * The terminals the people at the clients have in sight, one list for each connected
 * client (a session of the wire): a client's report replaces its last, and lapses when its
 * connection does, so a window that went away leaves no terminal held as seen. A terminal no
 * client lists is unseen, which lets the runner do what would move a person's view of it
 * (`Dialogs`, scrolling a held dialog into view).
 */
export class SeenTerminals {
  private readonly lists = new Map<string, ReadonlySet<string>>()
  private readonly listeners = new Set<(terminalId: string, seen: boolean) => void>()
  /** When each terminal last turned unseen. */
  private readonly unseenAt = new Map<string, number>()
  private readonly startedAt: number

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now()
  }

  /**
   * How long the terminal has gone unseen, in milliseconds: since a client last had it in
   * sight or its client's connection went, else since the runner began. Zero while seen.
   */
  unseenFor(terminalId: string): number {
    if (this.has(terminalId)) return 0
    return this.now() - (this.unseenAt.get(terminalId) ?? this.startedAt)
  }

  /** Whether some client has the terminal in sight. */
  has(terminalId: string): boolean {
    for (const list of this.lists.values()) if (list.has(terminalId)) return true
    return false
  }

  /** Client `client` has exactly these terminals in sight. */
  report(client: string, terminalIds: readonly string[]): void {
    this.replace(client, new Set(terminalIds))
  }

  /** The client has gone: nothing is in its sight any more. */
  release(client: string): void {
    this.replace(client, new Set())
  }

  /** Told of each terminal that turns seen or unseen, whichever client's change it was. */
  subscribe(listener: (terminalId: string, seen: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private replace(client: string, next: ReadonlySet<string>): void {
    const last = this.lists.get(client) ?? new Set<string>()
    const before = new Map([...new Set([...last, ...next])].map((id) => [id, this.has(id)]))
    if (next.size === 0) this.lists.delete(client)
    else this.lists.set(client, next)
    for (const [id, was] of before) {
      const now = this.has(id)
      if (now === was) continue
      if (!now) this.unseenAt.set(id, this.now())
      for (const listener of this.listeners)
        try {
          listener(id, now)
        } catch {
          // One listener's failure leaves the others.
        }
    }
  }
}
