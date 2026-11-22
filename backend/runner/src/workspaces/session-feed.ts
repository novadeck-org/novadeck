import type { SessionChange, WorkspaceSession } from "@novadeck/protocol"
import { KeyedChanges } from "@novadeck/wire/server"

/** What the feed reads of the sessions: each one's revision, and one as it is now. */
export type FeedStore = {
  readonly revisions: () => Readonly<Record<string, number>>
  readonly session: (sessionId: string) => WorkspaceSession
}

/**
 * Every session's changes, for the clients that share them (`sessions.watch`): first each
 * session's revision, then each session as it changes, each project's order of them once
 * arranged, and each one gone. A reader slower than
 * the changes gets each session once, as it is when it reads it, in the order they first
 * changed: a client lays its own unsent changes over whatever it reads, so a change folded
 * into a later one is never lost to it.
 */
export class SessionFeed {
  private readonly readers = new Set<KeyedChanges<string, SessionChange>>()

  constructor(private readonly store: FeedStore) {}

  /** Tells every reader of the session as it is now; `by` names the change it took. */
  changed(sessionId: string, by?: { readonly writer: string; readonly base: number }): void {
    if (this.readers.size === 0) return
    let session: WorkspaceSession
    try {
      session = this.store.session(sessionId)
    } catch {
      return
    }
    const change: SessionChange = {
      type: "changed",
      session,
      writer: by?.writer ?? null,
      base: by?.base ?? null,
    }
    for (const reader of this.readers) reader.changed(sessionId, change)
  }

  /** Tells every reader the project's sessions in their order, once arranged. */
  arranged(projectId: string, order: readonly string[]): void {
    for (const reader of this.readers)
      reader.changed(`project:${projectId}`, { type: "arranged", projectId, order: [...order] })
  }

  removed(sessionId: string): void {
    for (const reader of this.readers) reader.changed(sessionId, { type: "removed", sessionId })
  }

  /** One client's stream, until `signal` aborts. */
  async *watch(signal: AbortSignal): AsyncGenerator<SessionChange> {
    const reader = new KeyedChanges<string, SessionChange>([], {
      type: "revisions",
      revisions: this.store.revisions(),
    })
    this.readers.add(reader)
    const stop = () => reader.finish()
    signal.addEventListener("abort", stop, { once: true })
    try {
      while (!signal.aborted) {
        // eslint-disable-next-line no-await-in-loop -- Changes are read in order.
        const next = await reader.next()
        if (next === undefined) return
        yield next
      }
    } finally {
      signal.removeEventListener("abort", stop)
      this.readers.delete(reader)
      reader.finish()
    }
  }
}
