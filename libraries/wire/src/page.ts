import type { MessagePortLike } from "./channel.js"
import { messagePort, type Transport } from "./transport.js"

type PortMessage = {
  readonly data: unknown
  readonly source: unknown
  readonly ports: readonly MessagePortLike[]
}

// The page's window, as the members this uses: the library compiles without DOM types.
const page = globalThis as unknown as {
  addEventListener(type: "message", listener: (event: PortMessage) => void): void
  removeEventListener(type: "message", listener: (event: PortMessage) => void): void
}

/**
 * The page's side of `brokerPorts` and `relayPorts`: a page in Electron's renderer that asks
 * the main process for a fresh port on each connection, so reconnecting also works after the
 * app restarts its service. `request(id)` asks the main process, and throws if there's none
 * to ask; the port comes back as a window message `{ type: message, id }`. A port that
 * answers a request given up on is closed if it arrives within `lateAnswerMs`, so it holds
 * no connection open.
 */
export const brokeredPort = (options: {
  readonly request: (id: string) => void
  readonly message: string
  readonly lateAnswerMs: number
}): Transport =>
  messagePort(
    (signal) =>
      new Promise<MessagePortLike>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        const id = crypto.randomUUID()
        let cancelled = false
        let expiry: ReturnType<typeof setTimeout> | undefined
        const stop = () => {
          clearTimeout(expiry)
          page.removeEventListener("message", receive)
        }
        const receive = (event: PortMessage) => {
          const data = event.data
          const port = event.ports[0]
          if (event.source !== globalThis || !port) return
          if (typeof data !== "object" || data === null) return
          if (!("type" in data && data.type === options.message && "id" in data && data.id === id))
            return
          stop()
          signal.removeEventListener("abort", abort)
          // A port answering a cancelled request would hold a connection open.
          if (cancelled) port.close()
          else resolve(port)
        }
        const abort = () => {
          cancelled = true
          expiry = setTimeout(stop, options.lateAnswerMs)
          reject(signal.reason)
        }
        page.addEventListener("message", receive)
        signal.addEventListener("abort", abort, { once: true })
        try {
          options.request(id)
        } catch (error) {
          stop()
          signal.removeEventListener("abort", abort)
          reject(error)
        }
      }),
  )
