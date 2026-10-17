import { ipcMain, MessageChannelMain, type IpcMainEvent, type MessagePortMain } from "electron"

/**
 * Hands each page that asks a fresh port to a service, from Electron's main process. A
 * page asks with an IPC message on `channel` carrying a request id; `deliver` gets one end
 * of a new channel, and the page gets the other back on `channel` with that id. Ports can't
 * cross IPC's `invoke`, so the answer is a message of its own.
 *
 * `allow` decides who may ask: a port is whatever access the service gives. `deliver`
 * returns false when there's no service to hand the port to, as while it shuts down; the
 * request is then dropped, and the page's request runs out. Returns a function that stops.
 */
export const brokerPorts = (options: {
  readonly channel: string
  readonly allow: (event: IpcMainEvent) => boolean
  readonly deliver: (port: MessagePortMain) => boolean
}): (() => void) => {
  const listener = (event: IpcMainEvent, id: unknown) => {
    if (typeof id !== "string" || !options.allow(event)) return
    const { port1, port2 } = new MessageChannelMain()
    if (!options.deliver(port1)) {
      port1.close()
      port2.close()
      return
    }
    event.sender.postMessage(options.channel, id, [port2])
  }
  ipcMain.on(options.channel, listener)
  return () => ipcMain.removeListener(options.channel, listener)
}
