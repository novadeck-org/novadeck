import { RPCHandler } from "@orpc/server/message-port"

import type { Runner } from "./runner.js"

export type RunnerPort = Parameters<RPCHandler<object>["upgrade"]>[0] & {
  start?(): void
  close(): void
}

const onClose = (port: RunnerPort, listener: () => void): void => {
  if ("addEventListener" in port) port.addEventListener("close", listener)
  else if ("on" in port) port.on("close", listener)
}

/**
 * Serves one trusted client over a MessagePort, such as an Electron renderer's port
 * to a utility process. Holding the port is the credential. Returns a function that
 * closes the port and releases the client's terminals.
 */
export const servePort = (runner: Runner, port: RunnerPort): (() => void) => {
  const connection = runner.connect({
    verify: () => true,
    terminate: () => port.close(),
    onAuthenticated: () => {},
  })
  const disconnect = () => runner.disconnect(connection)
  new RPCHandler(runner.router).upgrade(port, { context: { connection } })
  onClose(port, disconnect)
  port.start?.()
  return () => {
    disconnect()
    port.close()
  }
}
