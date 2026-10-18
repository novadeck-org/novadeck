import { maxWebSocketMessageBytes } from "@novadeck/protocol"

import { startHttpServer, type HttpOptions, type HttpServer } from "./http.js"
import type { RunnerOptions } from "./runner.js"
import type { TerminalOptions } from "./terminals/index.js"

export type ServerOptions = HttpOptions &
  Readonly<{
    token?: string
    database?: string
    /** Where the shell integration goes; see `RunnerOptions.shell`. */
    shell?: string
    /** Where pasted files go; see `RunnerOptions.uploads`. */
    uploads?: string
    /** The relay agents start for Novadeck's MCP server and hooks; see `RunnerOptions.relay`. */
    relay?: string
    /** Voice input's engine and where it installs; see `RunnerOptions.voice`. */
    voice?: RunnerOptions["voice"]
    /** Murmur's engine and where it installs; see `RunnerOptions.murmur`. */
    murmur?: RunnerOptions["murmur"]
    terminals?: TerminalOptions
  }>

export type { HttpServer as Server } from "./http.js"

/** Standalone runner: HTTP status plus a token-authenticated WebSocket runner API. */
export const startServer = async (options: ServerOptions = {}): Promise<HttpServer> => {
  if (options.token === undefined) return startHttpServer(options)
  const [{ createRunner }, { serveWebSocket }] = await Promise.all([
    import("./index.js"),
    import("@novadeck/wire/server"),
  ])
  const runner = createRunner({
    ...(options.database !== undefined && { database: options.database }),
    ...(options.shell !== undefined && { shell: options.shell }),
    ...(options.uploads !== undefined && { uploads: options.uploads }),
    ...(options.relay !== undefined && { relay: options.relay }),
    ...(options.voice !== undefined && { voice: options.voice }),
    ...(options.murmur !== undefined && { murmur: options.murmur }),
    // A shared, network-reachable runner keeps a cap; the desktop runner has none.
    terminals: { maxTerminals: 32, ...options.terminals },
  })
  let sockets: ReturnType<typeof serveWebSocket>
  try {
    sockets = serveWebSocket(runner.sessions, {
      path: "/api/rpc",
      token: options.token,
      origins: options.origins ?? ["http://127.0.0.1:5173"],
      maxPayloadBytes: maxWebSocketMessageBytes,
      // Room for a terminal's largest initial snapshot, and the traffic beside it.
      sendBudgetBytes: runner.snapshotBytes + 8 * 1024 * 1024,
    })
  } catch (error) {
    await runner.close()
    throw error
  }
  return startHttpServer(options, {
    attach: (server) => server.on("upgrade", sockets.upgrade),
    async close() {
      try {
        await sockets.close()
      } finally {
        await runner.close()
      }
    },
  })
}
