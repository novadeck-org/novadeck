import {
  runnerPortMessage,
  updateChannels,
  updateNoteLength,
  updateNotesLength,
  updateVersionPattern,
  type DesktopBridge,
  type DesktopHost,
  type UpdateOffer,
} from "@novadeck/protocol/bridge"
import { contextBridge, ipcRenderer, webUtils } from "electron"

import {
  apiUrlArgumentPrefix,
  appearanceChannel,
  directoryPickerChannel,
  installUpdateChannel,
  noticeChannel,
  noticeClickChannel,
  openUpdatePageChannel,
  runnerPortChannel,
  saveBeforeQuitChannel,
  setUpdateChannelChannel,
  updateChannelChannel,
  updateOfferChannel,
  updateRequestChannel,
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

// Control and format characters, which include the marks that reorder text, and the line
// and paragraph separators.
const unwanted = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

// The offer when it is one the contract allows, or undefined. The host builds offers
// that obey it; this holds the page's side to it should the host be wrong or tricked.
// A note the page may not have is dropped rather than shortened.
const offerOf = (value: unknown): UpdateOffer | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { kind, version, notes } = value as Record<string, unknown>
  if (kind !== "ready" && kind !== "available") return undefined
  if (typeof version !== "string" || !updateVersionPattern.test(version)) return undefined
  const lines = Array.isArray(notes) ? (notes as unknown[]) : []
  return {
    kind,
    version,
    notes: lines
      .filter(
        (line): line is string =>
          typeof line === "string" &&
          line !== "" &&
          Array.from(line).length <= updateNoteLength &&
          !unwanted.test(line),
      )
      .slice(0, updateNotesLength),
  }
}

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
  // Only a valid offer comes back; the request makes the host answer with the last one,
  // as the page may have started listening after it arrived.
  onUpdate: (listener) => {
    const relay = (_event: unknown, value: unknown): void => {
      const offer = offerOf(value)
      if (offer) listener(offer)
    }
    ipcRenderer.on(updateOfferChannel, relay)
    ipcRenderer.send(updateRequestChannel)
    return () => {
      ipcRenderer.removeListener(updateOfferChannel, relay)
    }
  },
  installUpdate: () => {
    ipcRenderer.send(installUpdateChannel)
  },
  openUpdatePage: () => {
    ipcRenderer.send(openUpdatePageChannel)
  },
  updateChannel: async () => {
    const channel: unknown = await ipcRenderer.invoke(updateChannelChannel)
    return updateChannels.find((known) => known === channel) ?? "stable"
  },
  // Only a known channel crosses; the main process checks it again.
  setUpdateChannel: (channel) => {
    if (updateChannels.includes(channel)) ipcRenderer.send(setUpdateChannelChannel, channel)
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
