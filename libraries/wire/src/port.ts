import { RPCHandler } from "@orpc/server/message-port"

import { positive, type Sessions } from "./sessions.js"

/** A port to serve one client over: a DOM `MessagePort` or Electron's `MessagePortMain`. */
export type ServedPort = Parameters<RPCHandler<object>["upgrade"]>[0] & {
  start?(): void
  close(): void
}

const onClose = (port: ServedPort, listener: () => void): void => {
  if ("addEventListener" in port) port.addEventListener("close", listener)
  else if ("on" in port) port.on("close", listener)
}

/**
 * Serves one trusted client over a MessagePort, such as an Electron renderer's port to a
 * utility process. Holding the port is the credential, so the handshake needs no token.
 * Returns a function that ends the session and closes the port.
 */
export const servePort = (
  sessions: Sessions,
  port: ServedPort,
  options: {
    /**
     * Calls the client may have in flight. A trusted client may keep many busy at once, such
     * as a desktop app's acknowledgements, input and saves across all its terminals; the
     * bound only stops a runaway one from queueing unbounded work.
     */
    readonly maxCalls?: number
  } = {},
): (() => void) => {
  const session = sessions.open({
    verify: () => true,
    terminate: () => port.close(),
    authenticated: () => {},
    maxCalls: positive("maxCalls", options.maxCalls ?? 1024),
  })
  const close = () => sessions.close(session)
  new RPCHandler(sessions.router).upgrade(port, { context: { session } })
  onClose(port, close)
  port.start?.()
  return () => {
    close()
    port.close()
  }
}
