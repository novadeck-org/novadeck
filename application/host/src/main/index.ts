import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { access, constants, readFile, realpath } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { UpdateChannel } from "@novadeck/protocol/bridge"
import { startHttpServer, type HttpServer } from "@novadeck/runner/http"
import {
  app,
  autoUpdater as nativeUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
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
import {
  bundleVersionOf,
  offerMove,
  relaunchIntoCopy,
  resolveMoveConflict,
} from "./applications-folder.js"
import { dataFolderName } from "./data-folder.js"
import { linuxMenu } from "./menu.js"
import { notificationText, registerNoticeIpc, showNotices } from "./notices.js"
import { verifiedDebUpdater } from "./package-updaters.js"
import { attachPage, guardPage, lockPagesSession, pagesPartition, webAddress } from "./pages.js"
import { limitPermissions, ownPage } from "./permissions.js"
import { quitOnShutdown, saveBeforeClose, saveOnSessionEnd, savePages } from "./quit.js"
import { startRunner, type RunnerHost } from "./runner.js"
import { releaseDownloadsUrl, releasePageUrl, releaseRepositoryOf } from "./update-release.js"
import { keepUpdateState } from "./update-state.js"
import {
  bundleOf,
  checkForUpdates,
  developerIdSigned,
  installFallbackMs,
  installOnlyOnOrderlyQuit,
  installUpdate,
  quitWithoutInstalling,
  registerUpdateIpc,
  trackOffer,
  updatePlan,
  type Updater,
  type UpdaterKind,
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

// What the host remembers about updating: the channel, a failed install, the move prompt.
const updateState = keepUpdateState(join(app.getPath("userData"), "update.json"))

let server: HttpServer | undefined
let runner: RunnerHost | undefined
let stopping = false
// Whether the quit under way began the orderly way: closing the last window, or
// restarting into the update. On Linux Electron turns SIGTERM, SIGINT and SIGHUP into an
// ordinary quit, which must not install an update; see ./updater.ts.
let orderlyQuit = false
// The auto-updater of a build that looks for updates, once it has loaded, and what keeps
// its schedule.
let updater: (Updater & { quitAndInstall(silent: boolean, relaunch: boolean): void }) | undefined
let updates: ReturnType<typeof checkForUpdates> | undefined
// The releases this build follows; read from the data folder at launch.
let channel: UpdateChannel = "stable"

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
 * The repository the packaged build was released from, as `resources/app-update.yml`
 * names it, or undefined when that file is missing or names none GitHub could have.
 */
const releaseRepository = async (): Promise<ReturnType<typeof releaseRepositoryOf>> =>
  releaseRepositoryOf(
    await readFile(join(process.resourcesPath, "app-update.yml"), "utf8").catch(() => ""),
  )

/**
 * Where voice input finds its engine: the manifest shipped beside the UI, or the one
 * `pnpm build:engine` leaves in application/whisper; and the folder or address its
 * archive is downloaded from, which is the release this build came from once packaged,
 * in the repository app-update.yml names. Without one the source is empty, and installing
 * the engine fails rather than download from a guess.
 */
const voiceEngine = async (): Promise<{ engine: string; source: string }> => {
  if (!app.isPackaged) {
    const dist = join(app.getAppPath(), "..", "whisper", "dist")
    return { engine: join(dist, "engine.json"), source: dist }
  }
  const repository = process.env.NOVADECK_VOICE_SOURCE ? undefined : await releaseRepository()
  return {
    engine: join(process.resourcesPath, "voice", "engine.json"),
    // NOVADECK_VOICE_SOURCE points a build at another folder or address, as a local or
    // pull request build needs: it has no release of its own to download from.
    source:
      process.env.NOVADECK_VOICE_SOURCE ??
      (repository && releaseDownloadsUrl(repository, app.getVersion())) ??
      "",
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

// The last update offer, told to the app's pages as it arrives and to any that ask later.
const offers = trackOffer(() => appPages(BrowserWindow.getAllWindows()))

// Whether `codesign` finds a Developer ID signature on the running macOS app bundle; run
// once, as both the offer to move to Applications and the update plan ask.
let signature: Promise<boolean> | undefined
const bundleSigned = (): Promise<boolean> =>
  (signature ??= new Promise((resolve) => {
    execFile(
      "codesign",
      ["--display", "--verbose=2", bundleOf(app.getPath("exe"))],
      { timeout: 10_000 },
      // codesign reports on stderr, and exits non-zero for an unsigned bundle.
      (_error, stdout, stderr) => resolve(developerIdSigned(`${stdout}\n${stderr}`)),
    )
  }))

// Whether the signature matters to this launch: a packaged macOS build that looks for
// updates. Others never ask, and codesign takes a moment.
const checksSignature = (): boolean =>
  process.platform === "darwin" &&
  app.isPackaged &&
  app.getVersion() !== "0.0.0" &&
  process.env.NOVADECK_UPDATES !== "off"

/** What `resources/package-type` of a Linux package says, `deb` or `rpm`; undefined without it. */
const packageType = (): Promise<string | undefined> =>
  readFile(join(process.resourcesPath, "package-type"), "utf8").then(
    (text) => text.trim(),
    () => undefined,
  )

/** Whether the folder holding the AppImage file can be written to, as replacing it takes. */
const appImageWritable = (): Promise<boolean> => {
  const file = process.env.APPIMAGE
  return file
    ? access(dirname(file), constants.W_OK).then(
        () => true,
        () => false,
      )
    : Promise.resolve(false)
}

// electron-updater is CommonJS, so ESM takes its exports from the default. Each kind of
// build has its own updater; the one for the build is chosen here, from what was decided
// in ./updater.ts, rather than left to electron-updater to guess from the environment.
const loadUpdater = async (kind: UpdaterKind): Promise<NonNullable<typeof updater>> => {
  const { default: electronUpdater } = await import("electron-updater")
  switch (kind) {
    case "nsis":
      return new electronUpdater.NsisUpdater()
    case "mac":
      return new electronUpdater.MacUpdater()
    case "appimage":
      return new electronUpdater.AppImageUpdater()
    case "deb":
      return verifiedDebUpdater(electronUpdater.DebUpdater, () => offers.current()?.version)
    case "rpm":
      return new electronUpdater.RpmUpdater()
  }
}

// Starts checking for updates in a build that looks for them; see ./updater.ts.
const startUpdates = async (): Promise<void> => {
  const appDir = process.env.APPDIR
  const state = updateState.read()
  const linux = process.platform === "linux"
  const plan = updatePlan({
    packaged: app.isPackaged,
    version: app.getVersion(),
    platform: process.platform,
    execPath: process.execPath,
    // The AppImage mounts under TMPDIR, which may reach it through a symlink; the
    // executable's path is the real one.
    env: { ...process.env, APPDIR: appDir && (await realpath(appDir).catch(() => appDir)) },
    packageType: linux ? await packageType() : undefined,
    // Asked only where it matters: codesign takes a moment.
    signed: checksSignature() && (await bundleSigned()),
    appImageWritable: linux && (await appImageWritable()),
  })
  if (!plan) return
  updater = await loadUpdater(plan.kind)
  updates = checkForUpdates(updater, {
    mode: plan.mode,
    channel,
    failedVersion: state.installFailedOn,
    // Squirrel.Mac stages macOS updates; the others install from electron-updater's file.
    native: process.platform === "darwin" ? nativeUpdater : undefined,
    offer: offers.offer,
    // Synchronous: a failed install on quit is reported as the app exits.
    installFailed: (version) => {
      try {
        updateState.recordInstallFailure(version)
      } catch (error) {
        console.warn("The failed install was not kept.", error)
      }
    },
    log: (message, error) => console.warn(message, error),
  })
}

/** The page of the last offer's release, from the repository the build updates from. */
const updatePage = async (): Promise<string | undefined> => {
  const offer = offers.current()
  if (!offer) return undefined
  const repository = await releaseRepository()
  return repository && releasePageUrl(repository, offer.version)
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

// The version of the copy of this app already in Applications, if its Info.plist can be read.
const applicationsCopy = (): string => join("/Applications", basename(bundleOf(app.getPath("exe"))))
const installedVersion = (): string | undefined => {
  try {
    return bundleVersionOf(readFileSync(join(applicationsCopy(), "Contents", "Info.plist"), "utf8"))
  } catch {
    return undefined
  }
}

// On macOS, offers once per launch to move the app to Applications, the only place it can
// update itself from. Returns whether the app is restarting from there.
const moveToApplications = async (): Promise<boolean> => {
  const state = updateState.read()
  return offerMove({
    build: {
      packaged: app.isPackaged,
      version: app.getVersion(),
      platform: process.platform,
      env: process.env,
      inApplications: process.platform === "darwin" && app.isInApplicationsFolder(),
      declined: state.moveDeclined,
    },
    signed: () => (checksSignature() ? bundleSigned() : Promise.resolve(false)),
    ask: async () => {
      const { response, checkboxChecked } = await dialog.showMessageBox({
        type: "question",
        message: "Move Novadeck to your Applications folder?",
        detail:
          "Novadeck can only update itself when it runs from Applications. It moves there and starts again.",
        buttons: ["Move to Applications", "Not Now"],
        defaultId: 0,
        cancelId: 1,
        checkboxLabel: "Don't ask again",
      })
      return { move: response === 0, dontAskAgain: checkboxChecked }
    },
    decline: () => updateState.declineMove(),
    move: () => {
      const outcome = { conflict: "replace" as ReturnType<typeof resolveMoveConflict> }
      const moved = app.moveToApplicationsFolder({
        conflictHandler: (kind) => {
          outcome.conflict = resolveMoveConflict(kind, {
            existingVersion: installedVersion(),
            runningVersion: app.getVersion(),
          })
          return outcome.conflict === "replace"
        },
      })
      return moved ? "moved" : outcome.conflict === "newer" ? "newer" : "declined"
    },
    // The copy in Applications is newer: the person may open it instead of this one.
    tellNewer: async () => {
      const { response } = await dialog.showMessageBox({
        type: "info",
        message: "A newer Novadeck is already in your Applications folder.",
        detail: "This copy was not moved. Open the newer one instead?",
        buttons: ["Open Newer Novadeck", "Keep Using This One"],
        defaultId: 0,
        cancelId: 1,
      })
      if (response !== 0) return false
      // Nothing has started yet, so there is nothing to shut down.
      return relaunchIntoCopy({
        executable: join(applicationsCopy(), "Contents", "MacOS", basename(app.getPath("exe"))),
        exists: existsSync,
        relaunch: (execPath) => app.relaunch({ execPath }),
        exit: () => app.exit(0),
        log: (message, error) => console.warn(message, error),
      })
    },
    log: (message, error) => console.warn(message, error),
  })
}

const launch = async (): Promise<void> => {
  // A moved app starts again from Applications, and has nothing more to do here.
  if (await moveToApplications()) return
  channel = updateState.read().channel
  await appearance.restore(nativeTheme)
  runner = startRunner({
    entry: join(currentDirectory, "runner.js"),
    database: join(app.getPath("userData"), "workspace.sqlite"),
    relay: relayPath(),
    ...(await voiceEngine()),
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
  // The page learns of an update, can restart into a downloaded one or open the page of
  // one it must install itself, and chooses the releases the build follows.
  registerUpdateIpc(ipcMain, {
    window: (event) => appWindow(event)?.webContents,
    request: offers.request,
    install: () =>
      installUpdate({
        downloaded: () => offers.current()?.kind === "ready" && updater !== undefined,
        stopping: () => stopping,
        stop: () => {
          stopping = true
          orderlyQuit = true
        },
        shutdown: shutDown,
        install: () => updater?.quitAndInstall(true, true),
        quit: () => app.quit(),
        fallbackMs: installFallbackMs(process.platform),
      }),
    openPage: () => {
      void updatePage()
        .then((url) => {
          if (url) return shell.openExternal(url)
        })
        .catch((error: unknown) => console.warn("The release page did not open.", error))
    },
    channel: () => channel,
    setChannel: (next) => {
      if (next === channel) return
      channel = next
      updates?.setChannel(next)
      try {
        updateState.setChannel(next)
      } catch (error) {
        console.warn("The update channel was not kept.", error)
      }
    },
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
  // Ctrl+Q and the menu's Quit are the person's quit, which installs a waiting update; a
  // signal's is not. See ./menu.ts.
  if (process.platform === "linux")
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        linuxMenu(() => {
          orderlyQuit = true
          app.quit()
        }),
      ),
    )
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

const declineUnorderlyInstall = installOnlyOnOrderlyQuit(
  () => updater,
  () => orderlyQuit,
)

app.on("before-quit", (event) => {
  if (process.platform === "linux") declineUnorderlyInstall()
  if ((!server && !runner) || stopping) return

  event.preventDefault()
  stopping = true
  void shutDown().finally(() => app.quit())
})

app.on("window-all-closed", () => {
  orderlyQuit = true
  if (process.platform !== "darwin") app.quit()
})
