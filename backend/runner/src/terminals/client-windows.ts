/** Which of the clients following a stream gets an item: the owners it may go to, `undefined` for none preferred. */
export type Choose = (owners: readonly string[]) => string | undefined

/**
 * Which project each client shows, for the clients that say (the desktop app's project
 * windows), and when each was last used. A request an agent makes goes to the client that
 * shows the project of the terminal that asked, else the one used last, else (among clients
 * that say nothing, as every client does with project windows off) the newest, which
 * `Followers.newest` picks. A client's report replaces its last and lapses with its
 * connection, as `terminals.active` does.
 */
export class ClientWindows {
  /** Each reporting client's project and when it was last used. */
  private readonly clients = new Map<string, { projectId: string; usedAt: number }>()
  /** Counts uses, so "last" needs no clock. */
  private uses = 0

  constructor(private readonly projectOf: (sessionId: string) => string | undefined) {}

  /**
   * The client shows this project now. A client's first report doesn't count as use, so it
   * starts the least recent, as a window that reconnects in the background must not win over
   * the one the person uses; its later ones do. Told `null`, it says nothing of any project
   * from now on, as a client does with project windows off.
   */
  report(client: string, projectId: string | null): void {
    if (projectId === null) this.clients.delete(client)
    else this.clients.set(client, { projectId, usedAt: this.clients.has(client) ? ++this.uses : 0 })
  }

  /** A reporting client was used, as when it says which terminal its person uses. */
  touch(client: string): void {
    const known = this.clients.get(client)
    if (known) known.usedAt = ++this.uses
  }

  /**
   * The one of `owners` used last, among those that report; of equal use the later in the
   * list. Undefined where none reports.
   */
  lastUsed(owners: readonly string[]): string | undefined {
    let best: string | undefined
    for (const owner of owners) {
      const known = this.clients.get(owner)
      if (known && (best === undefined || known.usedAt >= (this.clients.get(best)?.usedAt ?? 0)))
        best = owner
    }
    return best
  }

  /** The client has gone. */
  release(client: string): void {
    this.clients.delete(client)
  }

  /** The choice for a request made by a terminal of `sessionId`. */
  choosing(sessionId: string): Choose {
    return (owners) => {
      const reporting = owners.filter((owner) => this.clients.has(owner))
      if (reporting.length === 0) return undefined
      let project: string | undefined
      try {
        project = this.projectOf(sessionId)
      } catch {
        // A session the runner doesn't know has no window of its own.
      }
      const showing = reporting.filter((owner) => this.clients.get(owner)?.projectId === project)
      const pool = project !== undefined && showing.length > 0 ? showing : reporting
      return pool.reduce((best, owner) =>
        (this.clients.get(owner)?.usedAt ?? 0) > (this.clients.get(best)?.usedAt ?? 0)
          ? owner
          : best,
      )
    }
  }
}
