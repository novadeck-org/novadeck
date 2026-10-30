import { ipcRenderer } from "electron"

// The preload compiles without DOM types; it uses only this member of the page.
declare const window: {
  postMessage(message: unknown, targetOrigin: string, transfer: readonly unknown[]): void
}

/**
 * The preload's half of `brokerPorts`. A port can't cross the context bridge, so the
 * preload relays each one the main process sends on `channel` to the page as a window
 * message `{ type: message, id }` carrying the port, for `brokeredPort` to take. Returns
 * the request the page's bridge exposes: it asks the main process for a port under `id`.
 */
export const relayPorts = (options: {
  readonly channel: string
  readonly message: string
}): ((id: string) => void) => {
  ipcRenderer.on(options.channel, (event, id: string) => {
    window.postMessage({ type: options.message, id }, "*", event.ports)
  })
  return (id) => {
    if (typeof id === "string") ipcRenderer.send(options.channel, id)
  }
}
