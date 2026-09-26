import { RunnerError } from "./errors.js"
import type { Transport } from "./runner.js"
import { portChannel, socketChannel, type MessagePortLike } from "./wire.js"

/** Reaches a separately deployed runner. The token travels in the handshake, never in the URL. */
export const websocket = (url: string | URL, options: { readonly token: string }): Transport => ({
  token: options.token,
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
        settle(new RunnerError("DISCONNECTED", "Could not reach the runner.")),
      )
    })
    return socketChannel(socket)
  },
})

/**
 * Reaches a runner bundled with its host, such as an Electron utility process. Holding
 * the port is the credential. Pass a function to obtain a fresh port on reconnection;
 * it should give up when `signal` aborts. A single port cannot reconnect once it closes.
 */
export const messagePort = (
  port: MessagePortLike | ((signal: AbortSignal) => Promise<MessagePortLike>),
): Transport => {
  let used = false
  return {
    async connect(signal) {
      if (typeof port === "function") return portChannel(await port(signal))
      if (used) throw new RunnerError("CLOSED", "The runner's MessagePort has closed.")
      used = true
      return portChannel(port)
    },
  }
}
