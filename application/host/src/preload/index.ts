import { runnerPortMessage, type DesktopBridge, type DesktopHost } from "@novadeck/protocol/bridge"
import { contextBridge, ipcRenderer, webUtils } from "electron"

import {
  apiUrlArgumentPrefix,
  appearanceChannel,
  directoryPickerChannel,
  noticeChannel,
  noticeClickChannel,
  runnerPortChannel,
  saveBeforeQuitChannel,
} from "../bridge.js"

const argument = process.argv.find((value) => value.startsWith(apiUrlArgumentPrefix))

if (!argument) throw new Error("Novadeck API URL was not provided by the desktop host")

const apiUrl = new URL(argument.slice(apiUrlArgumentPrefix.length))

if (apiUrl.protocol !== "http:" || apiUrl.hostname !== "127.0.0.1" || !apiUrl.port) {
  throw new Error("Novadeck API URL must be an HTTP loopback URL with an explicit port")
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
  // Only the three fields cross; the main process checks them.
  showNotice: (notice) => {
    ipcRenderer.send(noticeChannel, { id: notice?.id, title: notice?.title, body: notice?.body })
  },
  // Only a terminal id comes back.
  onNoticeClick: (listener) => {
    const relay = (_event: unknown, id: unknown): void => {
      if (typeof id === "string") listener(id)
    }
    ipcRenderer.on(noticeClickChannel, relay)
    return () => {
      ipcRenderer.removeListener(noticeClickChannel, relay)
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

contextBridge.exposeInMainWorld("novadeck", {
  apiUrl: apiUrl.href,
  livePages: true,
  ...bridge,
} satisfies DesktopHost)
