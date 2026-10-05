import { startHttpServer, type HttpOptions, type HttpServer } from "./http.js"
import type { TerminalOptions } from "./terminals/index.js"

export type ServerOptions = HttpOptions &
  Readonly<{
    token?: string
    database?: string
    /** Where the shell integration goes; see `RunnerOptions.shell`. */
    shell?: string
    /** Where pasted files go; see `RunnerOptions.uploads`. */
    uploads?: string
    /** The relay agents start for NovaDeck's MCP server and hooks; see `RunnerOptions.relay`. */
    relay?: string
    terminals?: TerminalOptions
    maxConnections?: number
    heartbeatMs?: number
  }>

export type { HttpServer as Server } from "./http.js"

/** Standalone runner: HTTP status plus a token-authenticated WebSocket runner API. */
export const startServer = async (options: ServerOptions = {}): Promise<HttpServer> => {
  if (options.token === undefined) return startHttpServer(options)
  const { createRunner, serveWebSocket } = await import("./index.js")
  const runner = createRunner({
    ...(options.database !== undefined && { database: options.database }),
    ...(options.shell !== undefined && { shell: options.shell }),
    ...(options.uploads !== undefined && { uploads: options.uploads }),
    ...(options.relay !== undefined && { relay: options.relay }),
    // A shared, network-reachable runner keeps a cap; the desktop runner has none.
    terminals: { maxTerminals: 32, ...options.terminals },
  })
  let sockets: ReturnType<typeof serveWebSocket>
  try {
    sockets = serveWebSocket(runner, {
      token: options.token,
      origins: options.origins ?? ["http://127.0.0.1:5173"],
      ...(options.maxConnections !== undefined && { maxConnections: options.maxConnections }),
      ...(options.heartbeatMs !== undefined && {
        heartbeatMs: options.heartbeatMs,
      }),
    })
  } catch (error) {
    await runner.close()
    throw error
  }
  return startHttpServer(options, {
    attach: (server) => sockets.attach(server),
    async close() {
      try {
        await sockets.close()
      } finally {
        await runner.close()
      }
    },
  })
}
