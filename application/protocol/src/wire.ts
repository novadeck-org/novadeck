import { createORPCClient } from "@orpc/client"
import { StandardRPCLink, type StandardLinkClient } from "@orpc/client/standard"
import { ClientPeer } from "@orpc/standard-server-peer"

import type { WireClient } from "./contract.js"
import { RunnerError } from "./errors.js"

/** A bidirectional message channel to a runner, such as a WebSocket or MessagePort. */
export type Channel = {
  readonly open: boolean
  send(message: string | Uint8Array<ArrayBuffer>): void
  listen(receive: (data: unknown) => void): void
  readonly closed: Promise<void>
  close(): void
}

/** The WebSocket members a channel needs; browsers, Node.js and `ws` all provide them. */
export type WebSocketLike = {
  readonly readyState: number
  binaryType: string
  send(data: string | Uint8Array<ArrayBuffer>): void
  close(): void
  addEventListener(type: "open" | "close" | "error", listener: () => void): void
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
}

/** The MessagePort members a channel needs; DOM, Node.js and Electron renderer ports provide them. */
export type MessagePortLike = {
  postMessage(message: unknown): void
  start?(): void
  close(): void
  addEventListener(type: "close", listener: () => void): void
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
}

const disconnected = () => new RunnerError("DISCONNECTED", "Runner connection is closed.")

// Closing locally settles `closed` at once: a DOM MessagePort only notifies its peer,
// and a closing WebSocket may take a round trip before its close event.
export const socketChannel = (socket: WebSocketLike): Channel => {
  socket.binaryType = "arraybuffer"
  let settle: (() => void) | undefined
  const closed = new Promise<void>((resolve) => {
    settle = resolve
  })
  socket.addEventListener("close", () => settle?.())
  return {
    get open() {
      return socket.readyState === 1
    },
    send: (message) => socket.send(message),
    listen: (receive) => socket.addEventListener("message", (event) => receive(event.data)),
    closed,
    close: () => {
      socket.close()
      settle?.()
    },
  }
}

/**
 * A remote close is detected through the port's `close` event, which Chromium-based
 * hosts such as Electron and Node.js provide.
 */
export const portChannel = (port: MessagePortLike): Channel => {
  let open = true
  let settle: (() => void) | undefined
  const closed = new Promise<void>((resolve) => {
    settle = () => {
      open = false
      resolve()
    }
  })
  port.addEventListener("close", () => settle?.())
  return {
    get open() {
      return open
    },
    send: (message) => port.postMessage(message),
    listen: (receive) => {
      port.addEventListener("message", (event) => receive(event.data))
      port.start?.()
    },
    closed,
    close: () => {
      port.close()
      settle?.()
    },
  }
}

/** Speaks the oRPC peer protocol over a channel. Requests fail once the channel closes. */
export const createWireClient = (channel: Channel): WireClient => {
  // oRPC 1.x's stock adapters can reject an async abort listener after a socket closes.
  // Keep oRPC's wire protocol; settle the peer instead of throwing from the send callback.
  const peer = new ClientPeer((message) => {
    if (!channel.open) {
      peer.close({ reason: disconnected() })
      return
    }
    try {
      channel.send(
        typeof message === "string"
          ? message
          : Uint8Array.from(message instanceof Uint8Array ? message : new Uint8Array(message)),
      )
    } catch (error) {
      peer.close({ reason: error })
    }
  })
  let received = Promise.resolve()
  channel.listen((data) => {
    received = received
      .then(async () => {
        await peer.message(
          data instanceof Blob ? await data.arrayBuffer() : (data as string | ArrayBuffer),
        )
      })
      .catch((error: unknown) => peer.close({ reason: error }))
  })
  void channel.closed.then(() => peer.close({ reason: disconnected() }))

  const transport: StandardLinkClient<Record<never, never>> = {
    async call(request) {
      request.signal?.throwIfAborted()
      if (!channel.open) throw disconnected()
      const response = await peer.request(request)
      return { ...response, body: () => Promise.resolve(response.body) }
    },
  }
  return createORPCClient(new StandardRPCLink(transport, { url: "http://orpc" }))
}
