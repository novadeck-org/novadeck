import {
  runnerPortMessage,
  type DesktopBridge,
  type DesktopDebugBridge,
  type DesktopHost,
} from "@novadeck/protocol/bridge"
import { contextBridge, ipcRenderer, webUtils } from "electron"

import {
  apiUrlArgumentPrefix,
  appearanceChannel,
  debugArgument,
  debugKillRunnerChannel,
  directoryPickerChannel,
  runnerPortChannel,
  saveBeforeQuitChannel,
} from "../bridge.js"

const argument = process.argv.find((value) => value.startsWith(apiUrlArgumentPrefix))

if (!argument) throw new Error("NovaDeck API URL was not provided by the desktop host")

const apiUrl = new URL(argument.slice(apiUrlArgumentPrefix.length))

if (apiUrl.protocol !== "http:" || apiUrl.hostname !== "127.0.0.1" || !apiUrl.port) {
  throw new Error("NovaDeck API URL must be an HTTP loopback URL with an explicit port")
}

// What the page finishes before its window closes or the app quits; a page without one
// answers at once.
let beforeQuit: (() => Promise<void>) | undefined

ipcRenderer.on(saveBeforeQuitChannel, () => {
  void Promise.resolve()
    .then(() => beforeQuit?.())
    .catch(() => {})
    .finally(() => ipcRenderer.send(saveBeforeQuitChannel))
})

const bridge = {
  requestRunner: (id) => {
    if (typeof id === "string") ipcRenderer.send(runnerPortChannel, id)
  },
  pickDirectory: async () => {
    const path: unknown = await ipcRenderer.invoke(directoryPickerChannel)
    return typeof path === "string" ? path : null
  },
  // Only the two fields cross; the main process checks them.
  showAppearance: (appearance) => {
    ipcRenderer.send(appearanceChannel, { scheme: appearance?.scheme, ground: appearance?.ground })
  },
  beforeQuit: (save) => {
    beforeQuit = save
    return () => {
      if (beforeQuit === save) beforeQuit = undefined
    }
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ""
    }
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
  livePages: true,
  ...bridge,
  ...(debug && debugBridge),
} satisfies DesktopHost)
