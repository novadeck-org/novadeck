import { realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { startHttpServer, type HttpServer } from "@novadeck/runner/http"
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron"

import {
  apiUrlArgumentPrefix,
  debugArgument,
  directoryPickerChannel,
  runnerPortChannel,
} from "../bridge.js"
import { debugEnabled, registerDebugIpc } from "./debug.js"
import { saveBeforeClose, savePages } from "./quit.js"
import { startRunner, type RunnerHost } from "./runner.js"

const appId = "dev.mzpk.novadeck"
// Whether this launch offers the debug panel: always in development, and in a
// packaged app only with --debug-panel or NOVADECK_DEBUG=1.
const debugging = debugEnabled({ argv: process.argv, env: process.env, packaged: app.isPackaged })
const developmentOrigin = "http://127.0.0.1:5173"
// How long quitting waits for the pages' last saves.
const saveBeforeQuitMs = 1_500
const currentDirectory = dirname(fileURLToPath(import.meta.url))

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

/** Whether a frame shows this app's own UI: the packaged page or the dev server. */
const isAppPage = (url: string): boolean => {
  const page = new URL(url)
  if (!app.isPackaged) return page.origin === developmentOrigin
  const packaged = pathToFileURL(join(process.resourcesPath, "ui", "index.html"))
  return page.protocol === "file:" && page.pathname === packaged.pathname
}

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
    backgroundColor: "#ffffff",
    webPreferences: {
      additionalArguments: [
        `${apiUrlArgumentPrefix}${apiUrl}`,
        ...(debugging ? [debugArgument] : []),
      ],
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(currentDirectory, "../preload/index.cjs"),
      sandbox: true,
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

  window.webContents.on("will-navigate", (event) => event.preventDefault())

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url)
    return { action: "deny" }
  })

  if (app.isPackaged) {
    void window.loadFile(join(process.resourcesPath, "ui", "index.html"))
  } else {
    void window.loadURL(developmentOrigin)
  }

  return window
}

const launch = async (): Promise<void> => {
  runner = startRunner({
    entry: join(currentDirectory, "runner.js"),
    database: join(app.getPath("userData"), "workspace.sqlite"),
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
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, respond) =>
    respond(false),
  )

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
