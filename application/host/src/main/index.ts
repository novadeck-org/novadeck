import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { startHttpServer, type HttpServer } from "@novadeck/runner/http"
import {
  app,
  autoUpdater as nativeUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  Notification,
  powerMonitor,
  session,
  shell,
  systemPreferences,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron"

import {
  apiUrlArgumentPrefix,
  directoryPickerChannel,
  noticeClickChannel,
  runnerPortChannel,
} from "../bridge.js"
import { keepAppearance, registerAppearanceIpc } from "./appearance.js"
import { dataFolderName } from "./data-folder.js"
import { notificationText, registerNoticeIpc, showNotices } from "./notices.js"
import { attachPage, guardPage, lockPagesSession, pagesPartition, webAddress } from "./pages.js"
import { limitPermissions, ownPage } from "./permissions.js"
import { quitOnShutdown, saveBeforeClose, saveOnSessionEnd, savePages } from "./quit.js"
import { startRunner, type RunnerHost } from "./runner.js"
import {
  bundleOf,
  checkForUpdates,
  developerIdSigned,
  installFallbackMs,
  installUpdate,
  quitWithoutInstalling,
  registerUpdateIpc,
  trackUpdate,
  updateMode,
  type Updater,
} from "./updater.js"

const appId = "dev.mzpk.novadeck"
// Where the app keeps its data; a development launch keeps its own (see ./data-folder.ts).
// One given by --user-data-dir, as the packaged smoke test gives, is kept; the switch
// without a folder names none.
if (!app.commandLine.getSwitchValue("user-data-dir"))
  app.setPath(
    "userData",
    join(app.getPath("appData"), dataFolderName({ packaged: app.isPackaged })),
  )
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
// The auto-updater of a build that updates itself, once it has loaded.
let updater: (Updater & { quitAndInstall(silent: boolean, relaunch: boolean): void }) | undefined

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

/** The relay agents start for Novadeck's MCP server and hooks: shipped beside the UI, or built. */
const relayPath = (): string => {
  const name = process.platform === "win32" ? "novadeck-relay.exe" : "novadeck-relay"
  return app.isPackaged
    ? join(process.resourcesPath, "relay", name)
    : join(app.getAppPath(), "..", "relay", "dist", name)
}

/**
 * Where voice input finds its engine: the manifest shipped beside the UI, or the one
 * `pnpm build:engine` leaves in application/whisper; and the folder or address its
 * archive is downloaded from, which is the release this build came from once packaged.
 */
const voiceEngine = (): { engine: string; source: string } => {
  if (!app.isPackaged) {
    const dist = join(app.getAppPath(), "..", "whisper", "dist")
    return { engine: join(dist, "engine.json"), source: dist }
  }
  return {
    engine: join(process.resourcesPath, "voice", "engine.json"),
    // NOVADECK_VOICE_SOURCE points a build at another folder or address, as a local or
    // pull request build needs: it has no release of its own to download from.
    source:
      process.env.NOVADECK_VOICE_SOURCE ??
      `https://github.com/mzpkdev/novadeck/releases/download/v${app.getVersion()}/`,
  }
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

// The pages of these windows that are alive and show the app, skipping any that crashed,
// went away, or show something other than the app.
const appPages = (windows: readonly BrowserWindow[]): WebContents[] =>
  windows
    .map((window) => window.webContents)
    .filter(
      (contents) =>
        !contents.isDestroyed() &&
        !contents.isCrashed() &&
        contents.getURL() !== "" &&
        isAppPage(contents.getURL()),
    )

// Asks these windows' pages to finish their saves.
const saveWindows = (windows: readonly BrowserWindow[]): Promise<void> =>
  savePages(ipcMain, appPages(windows), {
    sender: (answer) => appWindow(answer)?.webContents,
    timeoutMs: saveBeforeQuitMs,
  })

// What quitting and restarting into an update both run: every page saves before the runner
// ends its shells, so the saves name what still runs.
const shutDown = async (): Promise<void> => {
  await saveWindows(BrowserWindow.getAllWindows())
  await Promise.allSettled([runner?.close(), server?.close()])
}

// The version of the update downloaded, told to the app's pages as it arrives and to any
// that ask later.
const updates = trackUpdate(() => appPages(BrowserWindow.getAllWindows()))

/** Whether `codesign` finds a Developer ID signature on the running macOS app bundle. */
const bundleSigned = (): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(
      "codesign",
      ["--display", "--verbose=2", bundleOf(app.getPath("exe"))],
      { timeout: 10_000 },
      // codesign reports on stderr, and exits non-zero for an unsigned bundle.
      (_error, stdout, stderr) => resolve(developerIdSigned(`${stdout}\n${stderr}`)),
    )
  })

// Starts checking for updates in a build that updates itself; see ./updater.ts.
const startUpdates = async (): Promise<void> => {
  const appDir = process.env.APPDIR
  const mode = updateMode({
    packaged: app.isPackaged,
    version: app.getVersion(),
    platform: process.platform,
    execPath: process.execPath,
    // The AppImage mounts under TMPDIR, which may reach it through a symlink; the
    // executable's path is the real one.
    env: { ...process.env, APPDIR: appDir && (await realpath(appDir).catch(() => appDir)) },
  })
  if (mode === "no" || (mode === "signed" && !(await bundleSigned()))) return
  // electron-updater is CommonJS, so ESM takes its exports from the default.
  const { default: electronUpdater } = await import("electron-updater")
  updater = electronUpdater.autoUpdater
  checkForUpdates(updater, {
    // Squirrel.Mac stages macOS updates; the others install from electron-updater's file.
    native: process.platform === "darwin" ? nativeUpdater : undefined,
    downloaded: updates.downloaded,
    log: (message, error) => console.warn(message, error),
  })
}

// The quit of the system ending the session: no update installs on the way out, as the
// system may kill the installer halfway.
const quitOnSessionEnd = quitWithoutInstalling(
  () => updater,
  () => app.quit(),
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
      additionalArguments: [`${apiUrlArgumentPrefix}${apiUrl}`],
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
    quit: quitOnSessionEnd,
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
    ...voiceEngine(),
  })
  // A port is shell access: only the main frame of this app's own window showing its
  // own UI may ask for one.
  ipcMain.on(runnerPortChannel, (event, id: unknown) => {
    if (!appWindow(event) || typeof id !== "string") return
    runner?.connect(event.sender, id)
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
  // The page learns of a downloaded update, and can restart into it.
  registerUpdateIpc(ipcMain, {
    window: (event) => appWindow(event)?.webContents,
    request: updates.request,
    install: () =>
      installUpdate({
        downloaded: () => updates.version() !== undefined && updater !== undefined,
        stopping: () => stopping,
        stop: () => void (stopping = true),
        shutdown: shutDown,
        install: () => updater?.quitAndInstall(true, true),
        quit: () => app.quit(),
        fallbackMs: installFallbackMs(process.platform),
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
  void startUpdates().catch((error: unknown) => console.warn("Updates did not start.", error))
}

app.setAppUserModelId(appId)

app.whenReady().then(() => {
  // A system shutdown quits, which saves every page and terminal before the shells end.
  quitOnShutdown(powerMonitor, quitOnSessionEnd)
  limitPermissions(
    session.defaultSession,
    isAppPage,
    // macOS asks the person once, and remembers; elsewhere the page's own request is all.
    process.platform === "darwin"
      ? () => systemPreferences.askForMediaAccess("microphone")
      : undefined,
  )
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
  void shutDown().finally(() => app.quit())
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
