import { randomUUID } from "node:crypto"

import { createRouter, type Connection } from "./router.js"
import { Terminals, type TerminalOptions } from "./terminals/index.js"
import { WorkspaceStore } from "./workspaces/store.js"

export type RunnerOptions = {
  /** SQLite file for project and session metadata; in memory when omitted. */
  database?: string
  terminals?: TerminalOptions
}

export type Runner = {
  /** Identifies this runner lifetime; terminal cursors are only valid within it. */
  readonly id: string
  readonly router: ReturnType<typeof createRouter>
  /** The largest initial snapshot, which transports allow for in their send buffers. */
  readonly snapshotBytes: number
  /**
   * Opens a client connection whose handshake accepts the tokens `verify` approves.
   * `terminate` ends its transport when a newer connection of the same client replaces it.
   */
  connect(transport: Pick<Connection, "verify" | "terminate" | "onAuthenticated">): Connection
  /** Releases a connection's attachments and terminal control. Its shells keep running. */
  disconnect(connection: Connection): void
  /** Ends every shell and closes the metadata store. */
  close(): Promise<void>
}

/** Owns shells and workspace metadata, independent of how clients reach it. */
export const createRunner = (options: RunnerOptions = {}): Runner => {
  const id = randomUUID()
  const terminals = new Terminals(options.terminals)
  const store = new WorkspaceStore(options.database)
  const clients = new Map<string, Connection>()
  let closing: Promise<void> | undefined
  const disconnect = (connection: Connection) => {
    if (connection.closed) return
    connection.closed = true
    if (connection.clientId !== undefined && clients.get(connection.clientId) === connection) {
      clients.delete(connection.clientId)
    }
    terminals.release(connection.id)
  }
  // A client only notices a dead link first; release its stale connection now instead
  // of after missed heartbeats, so its reconnection can reclaim terminal control.
  const claim = (connection: Connection, clientId: string) => {
    const previous = clients.get(clientId)
    if (previous !== undefined && previous !== connection) {
      disconnect(previous)
      previous.terminate()
    }
    connection.clientId = clientId
    clients.set(clientId, connection)
  }
  return {
    id,
    router: createRouter({ runnerId: id, claim, store, terminals }),
    snapshotBytes: options.terminals?.snapshotBytes ?? 32 * 1024 * 1024,
    connect: (transport) => ({
      ...transport,
      id: randomUUID(),
      clientId: undefined,
      authenticated: false,
      closed: false,
      calls: 0,
    }),
    disconnect,
    close() {
      closing ??= (async () => {
        try {
          await terminals.shutdown()
        } finally {
          store.close()
        }
      })()
      return closing
    },
  }
}
