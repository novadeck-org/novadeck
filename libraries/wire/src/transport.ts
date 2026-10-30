import { portChannel, socketChannel, type Channel, type MessagePortLike } from "./channel.js"
import { WireError } from "./errors.js"

/** How a client reaches a server. See `websocket`, `messagePort` and `brokeredPort`. */
export type Transport = {
  /** Sent in the handshake. Trusted transports omit it. */
  readonly token?: string
  /** Opens one channel. Rejects with `CLOSED` when the transport can never connect again. */
  connect(signal: AbortSignal): Promise<Channel>
}

/**
 * Reaches a separately deployed server. The token, if any, travels in the handshake, never
 * in the URL.
 */
export const websocket = (
  url: string | URL,
  options: { readonly token?: string } = {},
): Transport => ({
  ...(options.token !== undefined && { token: options.token }),
  async connect(signal) {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const settle = (error?: unknown) => {
        signal.removeEventListener("abort", abort)
        if (error === undefined) resolve()
        else reject(error)
      }
      const abort = () => {
        socket.close()
        settle(signal.reason)
      }
      signal.addEventListener("abort", abort, { once: true })
      socket.addEventListener("open", () => settle())
      socket.addEventListener("close", () =>
        settle(new WireError("DISCONNECTED", "Could not reach the server.")),
      )
    })
    return socketChannel(socket)
  },
})

/**
 * Reaches a server bundled with the app, such as an Electron utility process. Holding
 * the port is the credential. Pass a function to obtain a fresh port on reconnection;
 * it should give up when `signal` aborts. A single port can't reconnect once it closes.
 */
export const messagePort = (
  port: MessagePortLike | ((signal: AbortSignal) => Promise<MessagePortLike>),
): Transport => {
  let used = false
  return {
    async connect(signal) {
      if (typeof port === "function") return portChannel(await port(signal))
      if (used) throw new WireError("CLOSED", "The MessagePort has closed.")
      used = true
      return portChannel(port)
    },
  }
}
