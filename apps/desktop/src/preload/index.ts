import {
  desktopBadgeOf,
  parsePortableState,
  parseUpdateOffer,
  parseWhatsNew,
  rendererPoolOf,
  webglContextsOf,
  runnerPortMessage,
  updateChannels,
  updateVersionPattern,
  type DesktopBridge,
  type DesktopHost,
  type FeedbackHostAbout,
  type PortableState,
  type SandboxState,
  type UninstallPlan,
  type UninstallResult,
} from "@novadeck/protocol/bridge"
import {
  pageSignInChannel,
  pageSignInMessage,
  parsePageSignIn,
} from "@novadeck/viewers/browser/sign-in"
import {
  pageRequestChannel,
  pageRequestMessage,
  parsePageRequest,
} from "@novadeck/viewers/browser/trouble"
import { relayPorts } from "@novadeck/wire/electron"
import { contextBridge, ipcRenderer, webUtils } from "electron"

import {
  allowUpdatesChannel,
  apiUrlArgumentPrefix,
  webglContextsArgumentPrefix,
  appearanceChannel,
  badgeChannel,
  directoryPickerChannel,
  dismissWhatsNewChannel,
  feedbackAboutChannel,
  feedbackArgumentPrefix,
  feedbackSendChannel,
  installAppChannel,
  portableStateChannel,
  noticeChannel,
  noticeClickChannel,
  noticeCloseChannel,
  notificationsQuietChannel,
  openLogsChannel,
  openUpdatePageChannel,
  pagePictureChannel,
  portableChannel,
  rendererPoolChannel,
  quitAppChannel,
  runnerPortChannel,
  sandboxChannel,
  saveBeforeQuitChannel,
  setUpdateChannelChannel,
  uninstallAppChannel,
  uninstallPlanChannel,
  uiErrorChannel,
  updateChannelChannel,
  versionChannel,
  updateOfferChannel,
  updateRequestChannel,
  whatsNewChannel,
  windowFocusChannel,
  windowFocusRequestChannel,
} from "../bridge.js"

const argument = process.argv.find((value) => value.startsWith(apiUrlArgumentPrefix))

if (!argument) throw new Error("Novadeck API URL was not provided by the desktop host")

const apiUrl = new URL(argument.slice(apiUrlArgumentPrefix.length))

// Whether the host sends feedback notes: it says so by an argument, `1`.
const feedback = process.argv.includes(`${feedbackArgumentPrefix}1`)

// What the host raised Chromium's WebGL context limit to, when it says so in a form the
// contract allows; the page keeps its browser default otherwise.
const webglContexts = webglContextsOf(
  Number(
    process.argv
      .find((value) => value.startsWith(webglContextsArgumentPrefix))
      ?.slice(webglContextsArgumentPrefix.length),
  ),
)

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

// A request a page in a view failed, as the main process tells of it: to the app's page as
// a window message, from which its viewer of that view takes it. Only a notice that is
// exactly what the viewer reads gets there.
ipcRenderer.on(pageRequestChannel, (_event, contentsId: unknown, failure: unknown) => {
  const fields = typeof failure === "object" && failure !== null ? failure : {}
  const notice = parsePageRequest({ ...fields, contentsId })
  if (notice) window.postMessage({ type: pageRequestMessage, ...notice }, "*")
})

// How many sign-in windows a page in a view has open, as the main process tells of it: to
// the app's page as a window message, so its viewer keeps that page live meanwhile.
ipcRenderer.on(pageSignInChannel, (_event, contentsId: unknown, open: unknown) => {
  const notice = parsePageSignIn({ contentsId, open })
  if (notice) window.postMessage({ type: pageSignInMessage, ...notice }, "*")
})

// Control and format characters, which include the marks that reorder text, and the line
// and paragraph separators.
const unwanted = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

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
const portableStateOf = (value: unknown): PortableState =>
  parsePortableState(value) ?? { portable: false }

// The longest command, folder list and folder path the page is given by an uninstall plan.
const uninstallCommandLength = 300
const uninstallFolders = 8
const uninstallPathLength = 1_000
const uninstallReasonLength = 300

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
  if (kind === "failed") return lineOf(reason, uninstallReasonLength) ? { kind, reason } : unknown
  return unknown
}

// A field of the page's error report, as text cut to `limit`; undefined for anything else.
const text = (value: unknown, limit: number): string | undefined =>
  typeof value === "string" ? value.slice(0, limit) : undefined

const bridge = {
  // The page asks for each port to the runner; its answer comes as a window message.
  requestRunner: relayPorts({ channel: runnerPortChannel, message: runnerPortMessage }),
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
      silent: notice?.silent,
    })
  },
  // Only a terminal id crosses; the main process checks it.
  closeNotice: (id) => {
    ipcRenderer.send(noticeCloseChannel, id)
  },
  // Only macOS plays Novadeck's sound from the notification itself.
  notificationsSound: process.platform === "darwin",
  // Only a boolean comes back, and anything else, or a failure, is false.
  notificationsQuiet: async () => {
    try {
      return (await ipcRenderer.invoke(notificationsQuietChannel)) === true
    } catch {
      return false
    }
  },
  // Only a valid badge crosses; the main process checks it again.
  setBadge: (badge) => {
    const checked = desktopBadgeOf(badge)
    if (checked) ipcRenderer.send(badgeChannel, checked)
  },
  // Only a boolean comes back; the request makes the host answer with the current one, as
  // the page may have started listening after the window last changed, or loaded again.
  onWindowFocus: (listener) => {
    const relay = (_event: unknown, focused: unknown): void => {
      if (typeof focused === "boolean") listener(focused)
    }
    ipcRenderer.on(windowFocusChannel, relay)
    ipcRenderer.send(windowFocusRequestChannel)
    return () => {
      ipcRenderer.removeListener(windowFocusChannel, relay)
    }
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
      const offer = parseUpdateOffer(value)
      if (offer) listener(offer)
    }
    ipcRenderer.on(updateOfferChannel, relay)
    ipcRenderer.send(updateRequestChannel)
    return () => {
      ipcRenderer.removeListener(updateOfferChannel, relay)
    }
  },
  openUpdatePage: () => {
    ipcRenderer.send(openUpdatePageChannel)
  },
  // Only macOS installs updates by its own swap, so only it has an administrator step.
  ...(process.platform === "darwin"
    ? {
        allowUpdates: () => {
          ipcRenderer.send(allowUpdatesChannel)
        },
      }
    : {}),
  updateChannel: async () => {
    const channel: unknown = await ipcRenderer.invoke(updateChannelChannel)
    return updateChannels.find((known) => known === channel) ?? "stable"
  },
  // Only a known channel crosses; the main process checks it again.
  setUpdateChannel: (channel) => {
    if (updateChannels.includes(channel)) ipcRenderer.send(setUpdateChannelChannel, channel)
  },
  // Only an answer the contract allows reaches the page; anything else is nothing to show.
  whatsNew: async () => parseWhatsNew(await ipcRenderer.invoke(whatsNewChannel)),
  dismissWhatsNew: () => {
    ipcRenderer.send(dismissWhatsNewChannel)
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
  // The host answers nothing: every step comes back through `onPortableState`.
  installApp: () => {
    ipcRenderer.send(installAppChannel)
  },
  // Only a valid state is passed on; a broken push is dropped, so it never hides a card
  // mid-install the way `portable()`'s fallback would.
  onPortableState: (listener) => {
    const relay = (_event: unknown, value: unknown): void => {
      const state = parsePortableState(value)
      if (state) listener(state)
    }
    ipcRenderer.on(portableStateChannel, relay)
    return () => {
      ipcRenderer.removeListener(portableStateChannel, relay)
    }
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
  openLogs: () => {
    ipcRenderer.send(openLogsChannel)
  },
  // The main process checks both again; the page never reaches the network itself.
  feedbackAbout: async () => (await ipcRenderer.invoke(feedbackAboutChannel)) as FeedbackHostAbout,
  sendFeedback: async (note) => {
    await ipcRenderer.invoke(feedbackSendChannel, { kind: note?.kind ?? null, text: note?.text })
  },
  // Only the four fields cross, as text; the main process checks them again.
  reportError: (error) => {
    ipcRenderer.send(uiErrorChannel, {
      kind: error?.kind === "rejection" ? "rejection" : "error",
      name: text(error?.name, 100) ?? "Error",
      message: text(error?.message, 2_000) ?? "",
      stack: text(error?.stack, 8_000),
    })
  },
  // Only the counts cross; the main process checks them again.
  reportRendererPool: (stats) => {
    const report = rendererPoolOf(stats)
    if (report) ipcRenderer.send(rendererPoolChannel, report)
  },
  // Only a JPEG picture comes back; the main process checks the page is one of this page's.
  pagePicture: async (page) => {
    const picture: unknown = await ipcRenderer.invoke(pagePictureChannel, page)
    return typeof picture === "string" && picture.startsWith("data:image/jpeg;base64,")
      ? picture
      : undefined
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ""
    }
  },
} satisfies DesktopBridge

contextBridge.exposeInMainWorld("novadeck", {
  apiUrl: apiUrl.href,
  livePages: true,
  ...(webglContexts === undefined ? {} : { webglContexts }),
  ...(feedback ? { feedback: true as const } : {}),
  ...bridge,
} satisfies DesktopHost)
