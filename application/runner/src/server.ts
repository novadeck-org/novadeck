import { startHttpServer, type HttpOptions, type HttpServer } from "./http.js"
import type { TerminalOptions } from "./terminals/index.js"

export type ServerOptions = HttpOptions &
  Readonly<{
    token?: string
    database?: string
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
    ...(options.terminals !== undefined && { terminals: options.terminals }),
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
