import { runnerPortMessage, type DesktopBridge } from "./bridge.js"
import { RunnerError } from "./errors.js"
import type { Transport } from "./runner.js"
import { messagePort } from "./transports.js"
import type { MessagePortLike } from "./wire.js"

/** How long a request's port may arrive after it was cancelled, so it can be closed. */
const lateAnswerMs = 60_000

const request = (signal: AbortSignal) =>
  new Promise<MessagePortLike>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const host = (globalThis as { novadeck?: Partial<DesktopBridge> }).novadeck
    if (!host?.requestRunner) {
      reject(new RunnerError("CLOSED", "No desktop host provides a runner."))
      return
    }
    const id = crypto.randomUUID()
    let cancelled = false
    let expiry: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      clearTimeout(expiry)
      removeEventListener("message", receive)
    }
    const receive = (event: MessageEvent) => {
      const data: unknown = event.data
      const port = event.ports[0]
      if (event.source !== window || !port) return
      if (typeof data !== "object" || data === null) return
      if (!("type" in data && data.type === runnerPortMessage && "id" in data && data.id === id)) {
        return
      }
      stop()
      signal.removeEventListener("abort", abort)
      // A port answering a cancelled request would hold a runner connection open.
      if (cancelled) port.close()
      else resolve(port)
    }
    const abort = () => {
      cancelled = true
      expiry = setTimeout(stop, lateAnswerMs)
      reject(signal.reason)
    }
    addEventListener("message", receive)
    signal.addEventListener("abort", abort, { once: true })
    host.requestRunner(id)
  })

/**
 * Reaches the runner bundled with the NovaDeck desktop app. Each connection asks the
 * host for a fresh port, so reconnecting also works after the host restarts its runner.
 */
export const desktop = (): Transport => messagePort(request)
