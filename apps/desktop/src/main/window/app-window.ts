// The app's own windows: opening one on the app's page, and telling a request or a page of
// the app's own UI from anything else a window may show.
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { Log } from "@novadeck/log"
import { pagesPartition } from "@novadeck/protocol/pages"
import { attachPage, webAddress } from "@novadeck/viewers/browser/host"
import {
  app,
  BrowserWindow,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron"

import { windowFocusChannel } from "../../bridge.js"
import { developmentOrigin, uiAddress, uiFile } from "../resources.js"
import { ownPage } from "./permissions.js"

// The folder the main process's bundle runs from, which the preload's sits beside.
const currentDirectory = dirname(fileURLToPath(import.meta.url))

/** Whether a frame shows this app's own UI: the packaged page or the dev server. */
export const isAppPage = (url: string): boolean => ownPage(url, uiAddress())

/**
 * The window of a request from the main frame of this app's own window showing its own
 * UI, or undefined for any other sender.
 */
export const appWindow = (event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | undefined => {
  const window = BrowserWindow.fromWebContents(event.sender)
  const frame = event.senderFrame
  if (!window || !frame || frame !== event.sender.mainFrame || !isAppPage(frame.url)) return
  return window
}

/**
 * The pages of these windows that are alive and show the app, skipping any that crashed,
 * went away, or show something other than the app.
 */
export const appPages = (windows: readonly BrowserWindow[]): WebContents[] =>
  windows
    .map((window) => window.webContents)
    .filter(
      (contents) =>
        !contents.isDestroyed() &&
        !contents.isCrashed() &&
        contents.getURL() !== "" &&
        isAppPage(contents.getURL()),
    )

/**
 * Tells a window's page whether the window has the system's focus; the page tracks it
 * itself only while its own document does, not while focus is inside a frame of it.
 */
export const tellWindowFocus = (window: BrowserWindow): void => {
  if (window.isDestroyed()) return
  const contents = window.webContents
  if (contents.isDestroyed() || !isAppPage(contents.getURL())) return
  contents.send(windowFocusChannel, window.isFocused())
}

/** Shows a window again, as a second launch asks for. */
export const bringForward = (window: BrowserWindow): void => {
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/**
 * Logs what goes wrong with a window's page, as the page itself can't tell: it hangs, it
 * didn't load, or its preload failed.
 */
export const watchAppPage = (contents: WebContents, log: Log): void => {
  contents.on("unresponsive", () =>
    log.warn("ui.unresponsive", "A window's page stopped answering."),
  )
  contents.on("responsive", () => log.info("ui.responsive", "A window's page answers again."))
  contents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
    if (mainFrame)
      log.error("ui.load-failed", "A window's page did not load.", {
        data: { code, description, url },
      })
  })
  contents.on("preload-error", (_event, _path, error) =>
    log.error("ui.preload-failed", "A window's preload failed.", { err: error }),
  )
}

/**
 * Opens a window on the app's page, hidden until its page is ready to show, on `ground`
 * so a dark theme never flashes white. `preloadArguments` reach its preload. It never
 * navigates away; links to the web open in the system's browser, and only page views of
 * the pages' partition attach.
 */
export const openAppWindow = ({
  ground,
  preloadArguments,
}: {
  readonly ground: string
  readonly preloadArguments: readonly string[]
}): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: ground,
    webPreferences: {
      additionalArguments: [...preloadArguments],
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(currentDirectory, "../preload/index.cjs"),
      sandbox: true,
      // Live pages in the companion pane; see @novadeck/viewers/browser/host.
      webviewTag: true,
    },
  })

  window.once("ready-to-show", () => window.show())
  window.on("focus", () => tellWindowFocus(window))
  window.on("blur", () => tellWindowFocus(window))

  window.webContents.on("will-navigate", (event) => event.preventDefault())

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (webAddress(url)) void shell.openExternal(url)
    return { action: "deny" }
  })

  window.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (!attachPage(preferences, params, pagesPartition)) event.preventDefault()
  })

  if (app.isPackaged) {
    void window.loadFile(uiFile())
  } else {
    void window.loadURL(developmentOrigin)
  }

  return window
}
