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

import { windowControlsSide, windowFocusChannel } from "../../bridge.js"
import { developmentOrigin, uiAddress, uiFile } from "../resources.js"
import { controlsWindowOptions } from "./controls.js"
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
  if (window.isDestroyed()) return
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
 * so a dark theme never flashes white, and at the app's scale `zoomFactor`. On macOS and
 * Windows its own controls sit in the page's header, which stands in for its title bar
 * (./controls.ts), Windows' in the page's `ink`.
 * `preloadArguments` reach its preload. It never
 * navigates away; links to the web open in the system's browser, and only page views of
 * the pages' partition attach.
 */
export const openAppWindow = ({
  ground,
  ink,
  zoomFactor,
  preloadArguments,
  bounds,
  maximized = false,
  route,
}: {
  readonly ground: string
  // The page's last ink, which Windows' caption buttons draw in until it says again.
  readonly ink?: string | undefined
  readonly zoomFactor: number
  readonly preloadArguments: readonly string[]
  // Where the window opens and how large; the system's place and the usual size without.
  readonly bounds?: {
    readonly width: number
    readonly height: number
    readonly x?: number
    readonly y?: number
  }
  readonly maximized?: boolean
  // The page's route, as its hash names it (`/projects/…`), to open on; the page's own choice
  // without one.
  readonly route?: string
}): BrowserWindow => {
  const window = new BrowserWindow({
    width: bounds?.width ?? 1120,
    height: bounds?.height ?? 720,
    ...(bounds?.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 760,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: ground,
    ...controlsWindowOptions(windowControlsSide(process.platform), {
      zoom: zoomFactor,
      ground,
      ink,
    }),
    webPreferences: {
      additionalArguments: [...preloadArguments],
      // The app's scale, so the first paint is at it (scale.ts re-applies it as the page loads).
      zoomFactor,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(currentDirectory, "../preload/index.cjs"),
      sandbox: true,
      // Live pages in the companion pane; see @novadeck/viewers/browser/host.
      webviewTag: true,
    },
  })

  window.once("ready-to-show", () => {
    if (maximized) window.maximize()
    window.show()
  })
  window.on("focus", () => tellWindowFocus(window))
  window.on("blur", () => tellWindowFocus(window))

  // The page moves through its hash routes without leaving, and Chromium then reports the title
  // of the history entry it makes, the page's at the moment it was made, over the one the page
  // has now: the page's own title, which names its project, is put back.
  window.webContents.on("did-navigate-in-page", () => {
    window.webContents
      .executeJavaScript("document.title")
      .then((title: unknown) => {
        if (!window.isDestroyed() && typeof title === "string" && title !== "")
          window.setTitle(title)
      })
      .catch(() => {})
  })

  window.webContents.on("will-navigate", (event) => event.preventDefault())
  // The app uses no WebRTC, and no page policy can keep a frame in it from opening a peer
  // connection, as a PDF's (libraries/viewers/src/pdf.ts) could: none of it sends UDP that
  // doesn't go through a proxy (see SECURITY.md, PDF Previews).
  window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (webAddress(url)) void shell.openExternal(url)
    return { action: "deny" }
  })

  window.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (!attachPage(preferences, params, pagesPartition)) event.preventDefault()
  })

  if (app.isPackaged) {
    void window.loadFile(uiFile(), route ? { hash: route } : {})
  } else {
    void window.loadURL(route ? `${developmentOrigin}/#${route}` : developmentOrigin)
  }

  return window
}
