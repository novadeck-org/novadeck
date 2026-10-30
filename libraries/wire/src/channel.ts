/** A bidirectional message channel, such as a WebSocket or a MessagePort. */
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
 * runtimes such as Electron and Node.js provide.
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
