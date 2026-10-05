import { realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { startHttpServer, type HttpServer } from "@novadeck/runner/http"
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  Notification,
  powerMonitor,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron"

import {
  apiUrlArgumentPrefix,
  debugArgument,
  directoryPickerChannel,
  noticeClickChannel,
  runnerPortChannel,
} from "../bridge.js"
import { keepAppearance, registerAppearanceIpc } from "./appearance.js"
import { debugEnabled, registerDebugIpc } from "./debug.js"
import { notificationText, registerNoticeIpc, showNotices } from "./notices.js"
import { attachPage, guardPage, lockPagesSession, pagesPartition, webAddress } from "./pages.js"
import { limitPermissions, ownPage } from "./permissions.js"
import { quitOnShutdown, saveBeforeClose, saveOnSessionEnd, savePages } from "./quit.js"
import { startRunner, type RunnerHost } from "./runner.js"

const appId = "dev.mzpk.novadeck"
// Where the app keeps its data (the workspace database, the shell files, Chromium's own),
// named alike on every platform. Electron would name it after the product, "novadeck.",
// whose trailing dot Windows drops from folder names, or keeps under some paths.
app.setPath("userData", join(app.getPath("appData"), "NovaDeck"))
// Whether this launch offers the debug panel: always in development, and in a
// packaged app only with --debug-panel or NOVADECK_DEBUG=1.
const debugging = debugEnabled({ argv: process.argv, env: process.env, packaged: app.isPackaged })
const developmentOrigin = "http://127.0.0.1:5173"
// How long quitting waits for the pages' last saves.
const saveBeforeQuitMs = 1_500
const currentDirectory = dirname(fileURLToPath(import.meta.url))

// The page's last appearance, which new windows open on so a dark theme never flashes
// white.
const appearance = keepAppearance(join(app.getPath("userData"), "appearance.json"))

let server: HttpServer | undefined
let runner: RunnerHost | undefined
let stopping = false

const waitFor = async (origin: string, attempts = 100): Promise<void> => {
  try {
    const response = await fetch(origin)
    if (response.ok) return
  } catch {
    // The UI dev server is still starting.
  }

  if (attempts === 1) throw new Error(`UI did not become ready at ${origin}`)

  await new Promise((resolve) => setTimeout(resolve, 100))
  return waitFor(origin, attempts - 1)
}

/** The relay agents start for NovaDeck's MCP server and hooks: shipped beside the UI, or built. */
const relayPath = (): string => {
  const name = process.platform === "win32" ? "novadeck-relay.exe" : "novadeck-relay"
  return app.isPackaged
    ? join(process.resourcesPath, "relay", name)
    : join(app.getAppPath(), "..", "relay", "dist", name)
}

/** Whether a frame shows this app's own UI: the packaged page or the dev server. */
const isAppPage = (url: string): boolean =>
  ownPage(
    url,
    app.isPackaged
      ? pathToFileURL(join(process.resourcesPath, "ui", "index.html")).href
      : developmentOrigin,
  )

/**
 * The window of a request from the main frame of this app's own window showing its own
 * UI, or undefined for any other sender.
 */
const appWindow = (event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | undefined => {
  const window = BrowserWindow.fromWebContents(event.sender)
  const frame = event.senderFrame
  if (!window || !frame || frame !== event.sender.mainFrame || !isAppPage(frame.url)) return
  return window
}

// Asks these windows' pages to finish their saves, skipping any that crashed, went away,
// or show something other than the app.
const saveWindows = (windows: readonly BrowserWindow[]): Promise<void> =>
  savePages(
    ipcMain,
    windows
      .map((window) => window.webContents)
      .filter(
        (contents) =>
          !contents.isDestroyed() &&
          !contents.isCrashed() &&
          contents.getURL() !== "" &&
          isAppPage(contents.getURL()),
      ),
    { sender: (answer) => appWindow(answer)?.webContents, timeoutMs: saveBeforeQuitMs },
  )

const createWindow = (origin: string): BrowserWindow => {
  const apiUrl = new URL("/api/", origin).href
  const window = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: appearance.current()?.ground ?? "#ffffff",
    webPreferences: {
      additionalArguments: [
        `${apiUrlArgumentPrefix}${apiUrl}`,
        ...(debugging ? [debugArgument] : []),
      ],
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(currentDirectory, "../preload/index.cjs"),
      sandbox: true,
      // Live pages in the companion pane; see ./pages.ts.
      webviewTag: true,
    },
  })

  window.once("ready-to-show", () => window.show())
  // Closing the last window quits, which ends the shells, except on macOS; either way
  // the page saves first.
  saveBeforeClose(
    window,
    () => saveWindows([window]),
    () => stopping,
  )

  // Windows ends a session through its windows: save while the shells still run.
  saveOnSessionEnd(window, {
    save: () => void saveWindows([window]).then(() => runner?.persist()),
    quit: () => app.quit(),
  })

  window.webContents.on("will-navigate", (event) => event.preventDefault())

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (webAddress(url)) void shell.openExternal(url)
    return { action: "deny" }
  })

  window.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (!attachPage(preferences, params)) event.preventDefault()
  })

  if (app.isPackaged) {
    void window.loadFile(join(process.resourcesPath, "ui", "index.html"))
  } else {
    void window.loadURL(developmentOrigin)
  }

  return window
}

const launch = async (): Promise<void> => {
  await appearance.restore(nativeTheme)
  runner = startRunner({
    entry: join(currentDirectory, "runner.js"),
    database: join(app.getPath("userData"), "workspace.sqlite"),
    relay: relayPath(),
  })
  // A port is shell access: only the main frame of this app's own window showing its
  // own UI may ask for one.
  ipcMain.on(runnerPortChannel, (event, id: unknown) => {
    if (!appWindow(event) || typeof id !== "string") return
    runner?.connect(event.sender, id)
  })
  registerDebugIpc(ipcMain, {
    enabled: debugging,
    allowed: (event) => appWindow(event) !== undefined,
    killRunner: () => runner?.kill() ?? false,
  })
  // The window follows the page: native menus and the page's prefers-color-scheme use
  // its scheme, and the window its ground.
  registerAppearanceIpc(ipcMain, {
    window: appWindow,
    show: (window, next) => {
      nativeTheme.themeSource = next.scheme
      window.setBackgroundColor(next.ground)
      void appearance.save(next)
    },
  })
  // The page's notices about its terminals, as the system's notifications; a click brings
  // the window to the front and tells its page which terminal to show.
  registerNoticeIpc(ipcMain, {
    window: appWindow,
    show: showNotices({
      supported: Notification.isSupported(),
      create: (notice) => new Notification(notificationText(notice, process.platform)),
      clicked: (window: BrowserWindow, id) => {
        if (window.isDestroyed()) return
        if (window.isMinimized()) window.restore()
        window.show()
        if (process.platform === "darwin") app.focus({ steal: true })
        window.focus()
        window.webContents.send(noticeClickChannel, id)
      },
    }),
  })
  ipcMain.handle(directoryPickerChannel, async (event) => {
    const window = appWindow(event)
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
    })
    const picked = result.canceled ? undefined : result.filePaths[0]
    // The runner stores real paths, so a folder opened through a symlink still matches.
    return picked === undefined ? null : realpath(picked).catch(() => picked)
  })
  server = await startHttpServer({
    port: 0,
    origins: app.isPackaged ? ["null"] : [developmentOrigin],
  })

  if (!app.isPackaged) await waitFor(developmentOrigin)

  createWindow(server.origin)
}

app.setAppUserModelId(appId)

app.whenReady().then(() => {
  // A system shutdown quits, which saves every page and terminal before the shells end.
  quitOnShutdown(powerMonitor, () => app.quit())
  limitPermissions(session.defaultSession, isAppPage)
  lockPagesSession(session.fromPartition(pagesPartition))
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "webview") guardPage(contents, (url) => shell.openExternal(url))
  })

  void launch().catch((error: unknown) => {
    console.error(error)
    app.exit(1)
  })

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (server) createWindow(server.origin)
    }
  })
})

app.on("before-quit", (event) => {
  if ((!server && !runner) || stopping) return

  event.preventDefault()
  stopping = true
  // Pages save before the runner ends its shells, so the saves name what still runs.
  void saveWindows(BrowserWindow.getAllWindows())
    .then(() => Promise.allSettled([runner?.close(), server?.close()]))
    .finally(() => app.quit())
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
