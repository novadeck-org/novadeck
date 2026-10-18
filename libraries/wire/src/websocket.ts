import { createHash, timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

import { RPCHandler } from "@orpc/server/ws"
import { WebSocket, WebSocketServer } from "ws"

import { positive, type Sessions } from "./sessions.js"

export type WebSocketOptions = {
  /** Where clients connect; any other path is refused. */
  readonly path: string
  /** The secret clients prove in their handshake, from 32 to 512 characters. */
  readonly token?: string
  /** Checks the handshake's token in place of `token`, for other authentication. */
  readonly verify?: (token: string | undefined) => boolean
  /** Browser origins allowed to connect; clients that send no origin, such as Node's, may too. */
  readonly origins: readonly string[]
  /** Sockets open at once, authenticated or not. */
  readonly maxConnections?: number
  /** Calls one session may have in flight. An untrusted peer may not queue unbounded work. */
  readonly maxCalls?: number
  /** How often a peer must answer a ping, or be dropped. */
  readonly heartbeatMs?: number
  /** How long a socket has to complete its handshake. */
  readonly authMs?: number
  /** The largest message a peer may send. */
  readonly maxPayloadBytes: number
  /** Bytes a socket may have waiting to send; a peer that can't keep up past it is dropped. */
  readonly sendBudgetBytes: number
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest()

const refuse = (socket: Duplex, status: number, message: string): void => {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

const tokenCheck = (token: string | undefined): ((token: string | undefined) => boolean) => {
  if (token === undefined) throw new Error("A WebSocket server needs a token or verify")
  if (token.length < 32 || token.length > 512) {
    throw new Error("The token must contain between 32 and 512 characters")
  }
  // Compared as digests, in constant time, so neither the token nor its length leaks.
  const secret = digest(token)
  return (given) => given !== undefined && timingSafeEqual(secret, digest(given))
}

/**
 * Serves sessions to WebSocket clients that authenticate in their handshake. Pass `upgrade`
 * an HTTP server's upgrade requests.
 */
export const serveWebSocket = (sessions: Sessions, options: WebSocketOptions) => {
  if (options.token !== undefined && options.verify !== undefined)
    throw new Error("A WebSocket server takes a token or verify, not both")
  const verify = options.verify ?? tokenCheck(options.token)
  const maxConnections = positive("maxConnections", options.maxConnections ?? 32)
  const maxCalls = positive("maxCalls", options.maxCalls ?? 32)
  const heartbeatMs = positive("heartbeatMs", options.heartbeatMs ?? 30_000)
  const authMs = positive("authMs", options.authMs ?? 10_000)
  const budget = positive("sendBudgetBytes", options.sendBudgetBytes)
  const maxPayload = positive("maxPayloadBytes", options.maxPayloadBytes)
  const handler = new RPCHandler(sessions.router)
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload,
    perMessageDeflate: false,
  })
  let stopping = false
  let stop: Promise<void> | undefined

  wss.on("connection", (socket) => {
    const timer = setTimeout(() => socket.close(1008, "Authentication required"), authMs)
    timer.unref()
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const session = sessions.open({
      verify,
      terminate: () => socket.terminate(),
      authenticated: () => clearTimeout(timer),
      maxCalls,
    })
    const cleanup = () => {
      clearTimeout(timer)
      if (heartbeat) clearInterval(heartbeat)
      sessions.close(session)
    }
    // ws calls close() when receiving the peer's close frame. Release the session before
    // replying, so a client that observes closure can immediately reconnect.
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
    // Bound the transport as well as whatever the app bounds in its streams.
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
      { context: { session } },
    )
  })

  return {
    /** Takes an HTTP server's upgrade request: a socket on `path`, unless refused. */
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      if (request.url !== options.path) return refuse(socket, 404, "Not Found")
      if (stopping) return refuse(socket, 503, "Service Unavailable")
      const origin = request.headers.origin
      if (origin !== undefined && !options.origins.includes(origin)) {
        return refuse(socket, 403, "Forbidden")
      }
      if (wss.clients.size >= maxConnections) return refuse(socket, 429, "Too Many Requests")
      wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request))
    },
    /** Refuses new sockets and ends every open one. */
    close(): Promise<void> {
      stop ??= (async () => {
        stopping = true
        for (const socket of wss.clients) socket.terminate()
        await new Promise<void>((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()))
        })
      })()
      return stop
    },
  }
}
