import {
  runnerPortMessage,
  type DesktopBridge,
  type DesktopDebugBridge,
  type DesktopHost,
} from "@novadeck/protocol/bridge"
import { contextBridge, ipcRenderer } from "electron"

import {
  apiUrlArgumentPrefix,
  debugArgument,
  debugKillRunnerChannel,
  directoryPickerChannel,
  runnerPortChannel,
} from "../bridge.js"

const argument = process.argv.find((value) => value.startsWith(apiUrlArgumentPrefix))

if (!argument) throw new Error("NovaDeck API URL was not provided by the desktop host")

const apiUrl = new URL(argument.slice(apiUrlArgumentPrefix.length))

if (apiUrl.protocol !== "http:" || apiUrl.hostname !== "127.0.0.1" || !apiUrl.port) {
  throw new Error("NovaDeck API URL must be an HTTP loopback URL with an explicit port")
}

const bridge = {
  requestRunner: (id) => {
    if (typeof id === "string") ipcRenderer.send(runnerPortChannel, id)
  },
  pickDirectory: async () => {
    const path: unknown = await ipcRenderer.invoke(directoryPickerChannel)
    return typeof path === "string" ? path : null
  },
} satisfies DesktopBridge

// The host compiles without DOM types; the preload uses only this member of the page.
declare const window: {
  postMessage(message: unknown, targetOrigin: string, transfer: readonly unknown[]): void
}

// A MessagePort cannot cross the context bridge, so it is relayed as a window message.
ipcRenderer.on(runnerPortChannel, (event, id: string) => {
  window.postMessage({ type: runnerPortMessage, id }, "*", event.ports)
})

// The main process passes this only when the debug panel is enabled for this launch.
const debug = process.argv.includes(debugArgument)

const debugBridge = {
  debug: true,
  // Kills the runner process, as a crash would.
  debugKillRunner: async () => (await ipcRenderer.invoke(debugKillRunnerChannel)) === true,
} satisfies DesktopDebugBridge

contextBridge.exposeInMainWorld("novadeck", {
  apiUrl: apiUrl.href,
  ...bridge,
  ...(debug && debugBridge),
} satisfies DesktopHost)
