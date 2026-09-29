import { randomUUID } from "node:crypto"

import { createHarnesses, type HarnessesOptions } from "./harnesses/service.js"
import { createRouter, type Connection } from "./router.js"
import { installShellFiles } from "./shell/install.js"
import { Terminals, type TerminalOptions } from "./terminals/index.js"
import { WorkspaceStore } from "./workspaces/store.js"

export type RunnerOptions = {
  /** SQLite file for project and session metadata; in memory when omitted. */
  database?: string
  /** Terminal limits; the number of terminals is unlimited unless `maxTerminals` is set. */
  terminals?: TerminalOptions
  /**
   * Where the shell integration, hook and agent plugins are written, such as a `shell`
   * folder beside the database. Without it shells start without the integration.
   */
  shell?: string
  /** Where agents are looked for and how their plugin commands run; for tests. */
  agents?: HarnessesOptions
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
  connect(
    transport: Pick<Connection, "verify" | "terminate" | "onAuthenticated" | "maxCalls">,
  ): Connection
  /** Releases a connection's attachments and terminal control. Its shells keep running. */
  disconnect(connection: Connection): void
  /** Saves every terminal's restore state now, as when the system is shutting down. */
  persist(): void
  /**
   * Saves every terminal, then refuses further saves of sessions and terminals, ends
   * every shell and closes the metadata store.
   */
  close(): Promise<void>
}

/** Owns shells and workspace metadata, independent of how clients reach it. */
export const createRunner = (options: RunnerOptions = {}): Runner => {
  const id = randomUUID()
  const store = new WorkspaceStore(options.database)
  // Written once, for the shells and for the agents that install NovaDeck's plugin.
  const shellFiles =
    options.shell === undefined
      ? Promise.resolve(undefined)
      : installShellFiles(options.shell).catch((error: unknown) => {
          console.error("NovaDeck shell integration is unavailable:", error)
          return undefined
        })
  const agents = createHarnesses(() => shellFiles, options.agents)
  const terminals = new Terminals({
    records: store,
    shellFiles,
    // Codex runs through NovaDeck's shim while it is connected; see `posixCodexShim`.
    shims: () => agents.shims(),
    connected: (agent) => agents.connected(agent),
    transcripts: store.settings().transcripts,
    ...options.terminals,
  })
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
    router: createRouter({
      runnerId: id,
      claim,
      store,
      terminals,
      agents,
      closing: () => closing !== undefined,
    }),
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
    persist: () => {
      if (!closing) terminals.persist()
    },
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
