import {
  isUpdatePercent,
  portableRunPattern,
  runnerPortMessage,
  updateChannels,
  updateNoteLength,
  updateNotesLength,
  updateVersionPattern,
  type DesktopBridge,
  type DesktopHost,
  type InstallResult,
  type PortableState,
  type SandboxState,
  type UninstallPlan,
  type UninstallResult,
  type UpdateOffer,
} from "@novadeck/protocol/bridge"
import { contextBridge, ipcRenderer, webUtils } from "electron"

import {
  apiUrlArgumentPrefix,
  appearanceChannel,
  directoryPickerChannel,
  installAppChannel,
  installUpdateChannel,
  noticeChannel,
  noticeClickChannel,
  openInstalledChannel,
  openUpdatePageChannel,
  portableChannel,
  quitAppChannel,
  runnerPortChannel,
  sandboxChannel,
  saveBeforeQuitChannel,
  setUpdateChannelChannel,
  uninstallAppChannel,
  uninstallPlanChannel,
  updateChannelChannel,
  versionChannel,
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

// What the date a copy fell behind is as the host reports it: an ISO 8601 date-time in UTC, as
// `Date.toISOString` writes it.
const datePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

// The offer when it is one the contract allows, or undefined. The host builds offers
// that obey it; this holds the page's side to it should the host be wrong or tricked.
// A note the page may not have is dropped rather than shortened.
const offerOf = (value: unknown): UpdateOffer | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { kind, version, notes, percent, outdatedSince } = value as Record<string, unknown>
  if (kind !== "downloading" && kind !== "ready" && kind !== "available") return undefined
  // Only a download has a percent, and it has one always.
  if (kind === "downloading" && !isUpdatePercent(percent)) return undefined
  if (typeof version !== "string" || !updateVersionPattern.test(version)) return undefined
  const lines = Array.isArray(notes) ? (notes as unknown[]) : []
  return {
    kind,
    version,
    ...(kind === "downloading" && isUpdatePercent(percent) ? { percent } : {}),
    ...(typeof outdatedSince === "string" && datePattern.test(outdatedSince)
      ? { outdatedSince }
      : {}),
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

// The longest fix command the page is given: one line, as the host builds it from a
// repository name.
const sandboxFixLength = 300

// The sandbox state when it is one the contract allows. Anything else counts as sandboxed,
// so a broken answer never raises a warning the page cannot back.
const sandboxOf = (value: unknown): SandboxState => {
  if (typeof value !== "object" || value === null) return { sandboxed: true }
  const { sandboxed, fix } = value as Record<string, unknown>
  if (sandboxed !== false) return { sandboxed: true }
  return {
    sandboxed: false,
    fix:
      typeof fix === "string" && fix.length <= sandboxFixLength && !unwanted.test(fix) ? fix : "",
  }
}

// The portable state when it is one the contract allows. Anything else counts as an
// installed copy, so a broken answer never offers an install the host would not do.
const portableStateOf = (value: unknown): PortableState => {
  if (typeof value !== "object" || value === null) return { portable: false }
  const { portable, version, run } = value as Record<string, unknown>
  if (
    portable !== true ||
    typeof version !== "string" ||
    !updateVersionPattern.test(version) ||
    typeof run !== "string" ||
    !portableRunPattern.test(run)
  )
    return { portable: false }
  return { portable: true, version, run }
}

// The longest reason an install may give the page for failing: a sentence.
const installReasonLength = 300

// The result of an install when it is one the contract allows. Anything else is a
// failure, as the page cannot tell what happened.
const installResultOf = (value: unknown): InstallResult => {
  const unknown: InstallResult = {
    kind: "failed",
    reason: "Something went wrong.",
  }
  if (typeof value !== "object" || value === null) return unknown
  const { kind, version, reason } = value as Record<string, unknown>
  if (kind === "installing") return { kind }
  if (kind === "newer")
    return typeof version === "string" && updateVersionPattern.test(version)
      ? { kind, version }
      : unknown
  if (kind === "failed")
    return typeof reason === "string" &&
      reason !== "" &&
      reason.length <= installReasonLength &&
      !unwanted.test(reason)
      ? { kind, reason }
      : unknown
  return unknown
}

// The longest command, folder list and folder path the page is given by an uninstall plan.
const uninstallCommandLength = 300
const uninstallFolders = 8
const uninstallPathLength = 1_000

// A line of text the page may show: not empty, not too long, no control characters.
const lineOf = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value !== "" && value.length <= limit && !unwanted.test(value)

// The uninstall plan when it is one the contract allows. Anything else counts as
// unavailable, so a broken answer never offers a removal the host would not do.
const uninstallPlanOf = (value: unknown): UninstallPlan => {
  const unavailable: UninstallPlan = { kind: "unavailable" }
  if (typeof value !== "object" || value === null) return unavailable
  const { kind, command, dataFolders, handoff } = value as Record<string, unknown>
  if (kind === "manual")
    return lineOf(command, uninstallCommandLength) ? { kind, command } : unavailable
  if (kind !== "ready" || (handoff !== "app" && handoff !== "uninstaller")) return unavailable
  if (!Array.isArray(dataFolders) || dataFolders.length > uninstallFolders) return unavailable
  const folders: unknown[] = dataFolders
  return folders.every((folder) => lineOf(folder, uninstallPathLength))
    ? { kind, dataFolders: folders as string[], handoff }
    : unavailable
}

// The result of an uninstall when it is one the contract allows. Anything else is a
// failure, as the page cannot tell what happened. A `leftover` that is not a plain line
// is dropped rather than shown.
const uninstallResultOf = (value: unknown): UninstallResult => {
  const unknown: UninstallResult = { kind: "failed", reason: "Something went wrong." }
  if (typeof value !== "object" || value === null) return unknown
  const { kind, leftover, reason } = value as Record<string, unknown>
  if (kind === "uninstalling") return { kind }
  if (kind === "removed")
    return lineOf(leftover, uninstallCommandLength) ? { kind, leftover } : { kind }
  if (kind === "failed") return lineOf(reason, installReasonLength) ? { kind, reason } : unknown
  return unknown
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
    ipcRenderer.send(appearanceChannel, {
      scheme: appearance?.scheme,
      ground: appearance?.ground,
    })
  },
  beforeQuit: (save) => {
    beforeQuit = save
    return () => {
      if (beforeQuit === save) beforeQuit = undefined
    }
  },
  // Only the three fields cross; the main process checks them.
  showNotice: (notice) => {
    ipcRenderer.send(noticeChannel, {
      id: notice?.id,
      title: notice?.title,
      body: notice?.body,
    })
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
  version: async () => {
    const version: unknown = await ipcRenderer.invoke(versionChannel)
    if (typeof version !== "string" || !updateVersionPattern.test(version)) {
      throw new Error("Unknown version")
    }
    return version
  },
  sandbox: async () => sandboxOf(await ipcRenderer.invoke(sandboxChannel)),
  portable: async () => portableStateOf(await ipcRenderer.invoke(portableChannel)),
  installApp: async () => installResultOf(await ipcRenderer.invoke(installAppChannel)),
  openInstalled: () => {
    ipcRenderer.send(openInstalledChannel)
  },
  uninstallPlan: async () => uninstallPlanOf(await ipcRenderer.invoke(uninstallPlanChannel)),
  // Only a boolean crosses; the main process keeps data unless it is told exactly `false`.
  uninstallApp: async (options) =>
    uninstallResultOf(
      await ipcRenderer.invoke(uninstallAppChannel, { keepData: options?.keepData !== false }),
    ),
  quitApp: () => {
    ipcRenderer.send(quitAppChannel)
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
