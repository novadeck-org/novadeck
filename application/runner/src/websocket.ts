import { createHash, timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

import type { ServerType } from "@hono/node-server"
import { RPCHandler } from "@orpc/server/ws"
import { WebSocket, WebSocketServer } from "ws"

import type { Runner } from "./runner.js"

export type WebSocketOptions = {
  token: string
  origins: readonly string[]
  maxConnections?: number
  heartbeatMs?: number
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest()

const refuse = (socket: Duplex, status: number, message: string): void => {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/** Serves a runner to token-authenticated WebSocket clients at `/api/rpc`. */
export const serveWebSocket = (runner: Runner, options: WebSocketOptions) => {
  if (options.token.length < 32 || options.token.length > 512) {
    throw new Error("NOVADECK_TOKEN must contain between 32 and 512 characters")
  }
  const maxConnections = options.maxConnections ?? 32
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
    throw new Error("maxConnections must be a positive integer")
  }
  const heartbeatMs = options.heartbeatMs ?? 30_000
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) {
    throw new Error("heartbeatMs must be a positive integer")
  }
  const secret = digest(options.token)
  const verify = (token: string | undefined) =>
    token !== undefined && timingSafeEqual(secret, digest(token))
  const budget = runner.snapshotBytes + 8 * 1024 * 1024
  const handler = new RPCHandler(runner.router)
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  })
  let stopping = false
  let stop: Promise<void> | undefined
  let server: ServerType | undefined

  wss.on("connection", (socket) => {
    const timer = setTimeout(() => socket.close(1008, "Authentication required"), 10_000)
    timer.unref()
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const connection = runner.connect({
      verify,
      terminate: () => socket.terminate(),
      onAuthenticated: () => clearTimeout(timer),
    })
    const cleanup = () => {
      clearTimeout(timer)
      if (heartbeat) clearInterval(heartbeat)
      runner.disconnect(connection)
    }
    // ws calls close() when receiving the peer's close frame. Release ownership
    // before replying, so a client that observes closure can immediately reconnect.
    const close = socket.close.bind(socket)
    socket.close = (code, reason) => {
      cleanup()
      close(code, reason)
    }
    socket.on("close", cleanup)
    socket.on("error", () => {
      cleanup()
      socket.terminate()
    })
    let alive = true
    socket.on("pong", () => {
      alive = true
    })
    heartbeat = setInterval(() => {
      if (!alive) {
        cleanup()
        socket.terminate()
        return
      }
      alive = false
      if (socket.readyState === WebSocket.OPEN) socket.ping()
    }, heartbeatMs)
    heartbeat.unref()
    // Bound the transport as well as each terminal's acknowledged stream.
    const send = (data: string | ArrayBufferLike | Uint8Array) => {
      const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength
      if (socket.bufferedAmount + bytes > budget) {
        cleanup()
        socket.terminate()
        return
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
    }
    void handler.upgrade(
      { addEventListener: socket.addEventListener.bind(socket), send },
      { context: { connection } },
    )
  })

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url !== "/api/rpc") return refuse(socket, 404, "Not Found")
    if (stopping) return refuse(socket, 503, "Service Unavailable")
    const origin = request.headers.origin
    if (origin !== undefined && !options.origins.includes(origin)) {
      return refuse(socket, 403, "Forbidden")
    }
    if (wss.clients.size >= maxConnections) return refuse(socket, 429, "Too Many Requests")
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request))
  }

  return {
    attach(httpServer: ServerType): void {
      server = httpServer
      server.on("upgrade", upgrade)
    },
    close(): Promise<void> {
      stop ??= (async () => {
        stopping = true
        server?.off("upgrade", upgrade)
        for (const socket of wss.clients) socket.terminate()
        await new Promise<void>((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()))
        })
      })()
      return stop
    },
  }
}
