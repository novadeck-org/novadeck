// The desktop app's main process: what runs before anything else, then the launch that starts
// the runner and opens the window, and the app's own events. Each domain is put together in
// its own folder; this hands them to each other.
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, realpath, rm } from "node:fs/promises"
import { homedir, release } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { consoleLogger, logPath, openSession, type Logger, type Session } from "@novadeck/log"
import type { DesktopBadge, DesktopFeedbackAbout } from "@novadeck/protocol/bridge"
import { startHttpServer, type HttpServer } from "@novadeck/runner/http"
import { brokerPorts } from "@novadeck/wire/electron"
import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  safeStorage,
  session,
  shell,
  systemPreferences,
} from "electron"

import {
  apiUrlArgumentPrefix,
  directoryPickerChannel,
  feedbackArgumentPrefix,
  noticeClickChannel,
  portableStateChannel,
  runnerPortChannel,
  versionChannel,
} from "../bridge.js"
import { openProcessLog, saltFileIn, type LogSetup } from "../logging.js"
import { dataFolderName, logsFolder } from "./data-folder.js"
import { feedbackAbout, feedbackOrigin, registerFeedbackIpc, sendFeedback } from "./feedback.js"
import { detectSoftwareGraphics } from "./graphics/software.js"
import { raiseWebglContexts, webglContextsArgument } from "./graphics/webgl.js"
import {
  appImageMounts,
  machineCopies,
  machineUninstaller,
  realpathOrUndefined,
  setupFolder,
} from "./install/copies.js"
import { installKind } from "./install/kind.js"
import { bundleOf } from "./install/mac.js"
import { installedEnvironment } from "./install/start.js"
import { registerUninstallIpc } from "./install/uninstall.js"
import { logNewDumps } from "./logs/crash-dumps.js"
import { goneBadly, goneData } from "./logs/process-gone.js"
import { registerLogIpc } from "./logs/ui.js"
import { updateLogOn } from "./logs/updates.js"
import { applyBadge, registerBadgeIpc } from "./notices/badge.js"
import { notificationOptions, registerNoticeIpc, showNotices } from "./notices/notices.js"
import { ntdllQuery, platformQuiet, registerQuietIpc, windowsProbe } from "./notices/quiet.js"
import { livePages } from "./pages.js"
import { portableInstaller, registerPortableIpc } from "./portable/installer.js"
import { portableLaunch } from "./portable/launch.js"
import { registerPortableLinksIpc, shownPath } from "./portable/links.js"
import { quitOnShutdown, saveBeforeClose, saveOnSessionEnd, savePages } from "./quit.js"
import { notQuitting } from "./quitting.js"
import {
  developmentOrigin,
  murmurEngine,
  relayPath,
  releaseRepository,
  voiceEngine,
  waitForUi,
} from "./resources.js"
import { logRunnerEvents, startRunner, type RunnerProcess } from "./runner.js"
import { registerSandboxIpc, sandboxState } from "./sandbox.js"
import { loadTranscriptKey } from "./transcript-key.js"
import { buildFacts } from "./updates/build.js"
import { updateNewsOf } from "./updates/news.js"
import { rememberReopen } from "./updates/quit-install.js"
import { keepUpdateState } from "./updates/state.js"
import { portableOf, registerUpdateIpc, trackOffer } from "./updates/updater.js"
import { updating } from "./updates/updating.js"
import { registerWhatsNewIpc } from "./updates/whats-new.js"
import {
  appPages,
  appWindow,
  bringForward,
  isAppPage,
  openAppWindow,
  tellWindowFocus,
  watchAppPage,
} from "./window/app-window.js"
import { keepAppearance, registerAppearanceIpc } from "./window/appearance.js"
import { registerWindowFocusIpc } from "./window/focus.js"
import { linuxMenu, macMenu } from "./window/menu.js"
import { limitPermissions } from "./window/permissions.js"
import { keepSpellcheckOffline } from "./window/spellcheck.js"

const appId = "dev.mzpk.novadeck"
// The WebGL context limit, raised before the app is ready; the pages are told it.
const webglContexts = raiseWebglContexts(app.commandLine)

// Where the person's feedback notes go: novadeck.dev once packaged, and from a development
// run only to the local website NOVADECK_FEEDBACK_ORIGIN names. Without one the app has no
// feedback card.
const feedbackTo = feedbackOrigin({
  packaged: app.isPackaged,
  platform: process.platform,
  version: app.getVersion(),
  env: process.env.NOVADECK_FEEDBACK_ORIGIN,
})
const feedbackDetails = (): DesktopFeedbackAbout =>
  feedbackAbout({ version: app.getVersion(), platform: process.platform, arch: process.arch })
// Where the app keeps its data; a development launch keeps its own (see ./data-folder.ts).
// One given by --user-data-dir, as the packaged smoke test gives, is kept; the switch
// without a folder names none.
if (!app.commandLine.getSwitchValue("user-data-dir"))
  app.setPath(
    "userData",
    join(app.getPath("appData"), dataFolderName({ packaged: app.isPackaged })),
  )
// One instance runs per data folder: Chromium's singleton lock is keyed on userData, so a
// portable and an installed copy, which share it, exclude each other, as two windows on
// one database must not run. A second launch quits at once, before it starts anything,
// and the first brings its window forward; see the `second-instance` handler below.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) {
  // A development run shares its folder across worktrees, so say whose it is.
  console.error(`Novadeck is already running on the data folder ${app.getPath("userData")}.`)
  app.exit(0)
}
// Where this launch's logs go (see ./data-folder.ts); a bug report attaches them.
app.setAppLogsPath(
  logsFolder({
    platform: process.platform,
    home: app.getPath("home"),
    userData: app.getPath("userData"),
    packaged: app.isPackaged,
    ownDataFolder: Boolean(app.commandLine.getSwitchValue("user-data-dir")),
  }),
)
// A native crash leaves a minidump in crashDumps, which the next launch logs by name and
// size; none is ever sent anywhere.
crashReporter.start({ uploadToServer: false })

// Names this launch in every line of both logs, the main process's and the runner's; never
// kept.
const launchId = randomUUID()
// Verbose logging, for a person collecting a bug report: lines that may hold what a
// terminal's screen showed are written too.
const verboseLogs = process.env.NOVADECK_LOGS === "verbose"
// Where the app's own code runs from, which its stack frames name: the app bundle on macOS,
// the folder of the executable elsewhere (an AppImage's mount changes every launch).
const installFolder = (): string =>
  !app.isPackaged
    ? app.getAppPath()
    : process.platform === "darwin"
      ? bundleOf(app.getPath("exe"))
      : dirname(process.execPath)
// What a process of this launch needs to write its log; `run` numbers the runner's starts.
const logSetup = (run?: number): LogSetup => ({
  folder: app.getPath("logs"),
  sid: launchId,
  ...(run !== undefined && { run }),
  verbose: verboseLogs,
  places: {
    userData: app.getPath("userData"),
    logs: app.getPath("logs"),
    crashDumps: app.getPath("crashDumps"),
    install: installFolder(),
  },
  saltFile: saltFileIn(app.getPath("userData")),
  resume: {
    version: app.getVersion(),
    os: process.platform,
    osVersion: release(),
    arch: process.arch,
  },
})
// The main process's log: host.log, written by this, the primary instance, alone.
const logger: Logger = primaryInstance
  ? openProcessLog("host", logSetup(), { echo: !app.isPackaged })
  : consoleLogger()
const log = logger.for("main")
// Each module's warnings, as the modules that take a `log` report them.
const warnings =
  (src: string) =>
  (message: string, error?: unknown): void =>
    logger.for(src).warn(`${src}.warning`, message, error === undefined ? {} : { err: error })
// The launch's records, opened at once, before anything can wait: a launch that crashes on its
// way up, as one right after an update may, is found by the next. The primary instance's
// alone: a second launch quits without touching the marker. Said what it is once the build is
// known, and ended as the process exits.
const records: Session | undefined = primaryInstance
  ? openSession({
      marker: join(app.getPath("logs"), "session.json"),
      sid: launchId,
      log: logger.for("session"),
      logFile: logPath(app.getPath("logs"), "host"),
    })
  : undefined
// Electron's app.exit ends the process without Node's `exit` event, which app.quit emits:
// every exit of the app goes through here, so its end is logged.
const exitApp = (code: number): void => {
  records?.end({ code })
  logger.close()
  app.exit(code)
}
// Logged as they happen; what follows is as it ever was: an uncaught exception shows
// Electron's dialog, and a promise rejected with nothing to catch it is only a warning.
process.on("uncaughtExceptionMonitor", (error, origin) =>
  log.fatal("host.uncaught", "The main process hit an error nothing caught.", {
    data: { origin },
    err: error,
  }),
)
process.on("unhandledRejection", (reason) => {
  log.error("host.rejection", "A promise in the main process failed with nothing to catch it.", {
    err: reason,
  })
  console.error("Unhandled rejection:", reason)
})
process.on("exit", (code) => {
  records?.end({ code })
  logger.close()
})

// How long quitting waits for the pages' last saves.
const saveBeforeQuitMs = 1_500
// The folder the main process's bundle runs from, which the runner's entry sits beside.
const currentDirectory = dirname(fileURLToPath(import.meta.url))

// The page's last appearance, which new windows open on so a dark theme never flashes
// white.
const appearance = keepAppearance(join(app.getPath("userData"), "appearance.json"))
// What the app remembers about updating: the channel, a failed install, how long this copy
// is behind.
const updateState = keepUpdateState(join(app.getPath("userData"), "update.json"))
// Whether the app ran in this data folder before this launch, which the runner's database
// shows: it is made when the first launch starts the runner and never removed, and older
// builds, which kept no last-run version, made it too. Read here, before the runner starts,
// so this launch's own database doesn't count; see `whatsNewAtLaunch`.
const ranBefore = existsSync(join(app.getPath("userData"), "workspace.sqlite"))
// The log of updating, in the main process's log; see `updateLogOn` in ./logs/updates.ts.
const updatesLog = updateLogOn(logger.for("updates"))

const quitting = notQuitting()
let server: HttpServer | undefined
let runner: RunnerProcess | undefined
// Names this run of the app; see `PortableHost.run`.
const run = randomUUID()

// The live pages of the companion pane, and the agents' looks at pages out of sight.
const pages = livePages()
const { looker } = pages

// The app's own windows: a look's is out of sight and no one's to save, show or count.
const appWindows = (): BrowserWindow[] =>
  BrowserWindow.getAllWindows().filter((window) => !looker.is(window))

// The last update offer, told to the app's pages as it arrives and to any that ask later.
const offers = trackOffer(() => appPages(appWindows()))
// The version the last offer names as available, which an install from a portable copy
// fetches.
const offered = (): string | undefined => {
  const offer = offers.current()
  return offer?.kind === "available" ? offer.version : undefined
}

// The copies of the app on this machine: the installed ones, and starting one in this one's
// place.
const copies = machineCopies({ appId, exitApp, offered, log: warnings("install") })
// What decides how this build updates, and the updates themselves.
const build = buildFacts(copies.windowsInstalled)
const updates = updating({
  state: updateState,
  log: updatesLog,
  offers,
  build,
  quitting,
  startBundle: copies.startBundle,
  startAppImage: copies.startInstalled,
})
// What is new after an update, and in the version a portable copy is offered.
const news = updateNewsOf({
  state: updateState,
  ranBefore,
  offered,
  warn: (message, error) => updatesLog.warn(message, error),
})
// A portable launch giving way to a newer copy.
const portableCopies = portableLaunch({ copies, exitApp, log: warnings("portable") })

// Asks these windows' pages to finish their saves.
const saveWindows = (windows: readonly BrowserWindow[]): Promise<void> =>
  savePages(ipcMain, appPages(windows), {
    sender: (answer) => appWindow(answer)?.webContents,
    timeoutMs: saveBeforeQuitMs,
  })

// What quitting and restarting into an update both run: every page saves before the runner
// ends its shells, so the saves name what still runs.
const shutDown = async (): Promise<void> => {
  await saveWindows(appWindows())
  await Promise.allSettled([runner?.close(), server?.close()])
}

// The page's Inbox count on the app's icon, as this platform shows one.
const badgeOf = (window: BrowserWindow, badge: DesktopBadge): void =>
  applyBadge({ platform: process.platform, app, nativeImage, window }, badge)

// Opens a window on the app's page, whose preload learns the API's address, the WebGL
// context limit and whether the app sends feedback notes.
const createWindow = (origin: string): BrowserWindow => {
  const apiUrl = new URL("/api/", origin).href
  const window = openAppWindow({
    ground: appearance.current()?.ground ?? "#ffffff",
    preloadArguments: [
      `${apiUrlArgumentPrefix}${apiUrl}`,
      webglContextsArgument(webglContexts),
      ...(feedbackTo ? [`${feedbackArgumentPrefix}1`] : []),
    ],
  })
  // Closing the last window quits, which ends the shells, except on macOS; either way
  // the page saves first.
  saveBeforeClose(
    window,
    () => saveWindows([window]),
    () => quitting.stopping,
  )
  // Windows ends a session through its windows: save while the shells still run.
  saveOnSessionEnd(window, {
    save: () => void saveWindows([window]).then(() => runner?.persist()),
    quit: updates.quitOnSessionEnd,
  })
  return window
}

// Shows the logs folder in the system's file manager, its host.log selected, which a bug
// report attaches.
const openLogs = (): void => {
  const folder = app.getPath("logs")
  void mkdir(folder, { recursive: true })
    .then(() => shell.showItemInFolder(logPath(folder, "host")))
    .catch((error: unknown) =>
      log.warn("logs.open-failed", "The logs folder did not open.", { err: error }),
    )
}

// The key saved transcripts are encrypted with, asked for as the app is ready and never
// waited on: a Linux keyring may ask the person to unlock it, and neither the window nor
// the runner holds back for that. Null where none can be kept safe.
const loadKey = (): Promise<string | null> =>
  loadTranscriptKey({
    storage: safeStorage,
    platform: process.platform,
    file: join(app.getPath("userData"), "transcript-key"),
    log: logger.for("transcript-key"),
  }).catch((error: unknown) => {
    log.warn("transcript-key.failed", "The transcript key could not be loaded.", { err: error })
    return null
  })
let transcriptKey: Promise<string | null> = Promise.resolve(null)

const launch = async (): Promise<void> => {
  // The signature is not asked here: it takes a moment, and a portable copy is told
  // without it.
  const known = await build.unsignedBuild()
  const portable = portableOf({ ...known, signed: false })
  // The launch says what it is, and the crashes of the launches before it.
  records?.start({
    version: app.getVersion(),
    channel: updateState.read().channel,
    install: installKind({ ...known, appImage: known.env.APPIMAGE !== undefined }),
    portable,
    os: process.platform,
    osVersion: release(),
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    locale: app.getLocale(),
    verbose: verboseLogs,
  })
  logNewDumps(
    app.getPath("crashDumps"),
    join(app.getPath("logs"), "crash-dumps.json"),
    logger.for("crash"),
  )
  if (await updates.openSwappedAppImage(portable)) return
  if (await portableCopies.leaveForNewer(portable)) return
  // The installed copy has no use for a setup the portable copy left; the installer that
  // started this copy may still hold it for a moment, so this waits, and gives up quietly.
  if (process.platform === "win32" && app.isPackaged && !portable)
    setTimeout(
      () => void rm(setupFolder(), { recursive: true, force: true }).catch(() => {}),
      60_000,
    ).unref()
  updates.readChannel()
  await appearance.restore(nativeTheme)
  // The engines' manifests and the graphics verdict are looked up together. The verdict is
  // asked on Windows only, where the GPU process answers once the app is ready.
  const [voice, murmur, softwareGraphics] = await Promise.all([
    voiceEngine(),
    murmurEngine(),
    detectSoftwareGraphics(app),
  ])
  // Settled before the runner makes its database, which marks a data folder as used: a
  // launch that dies in between must not make the next one look like an update.
  await news.settleLaunch()
  runner = startRunner({
    transcriptKey,
    entry: join(currentDirectory, "runner.js"),
    database: join(app.getPath("userData"), "workspace.sqlite"),
    relay: relayPath(),
    engine: voice.manifest,
    source: voice.source,
    murmurEngine: murmur.manifest,
    murmurSource: murmur.source,
    softwareGraphics,
    log: (start) => JSON.stringify(logSetup(start)),
    events: logRunnerEvents(logger, !app.isPackaged),
  })
  // A port is shell access: only the main frame of this app's own window showing its
  // own UI may ask for one.
  brokerPorts({
    channel: runnerPortChannel,
    allow: (event) => appWindow(event) !== undefined,
    deliver: (port) => runner?.deliver(port) ?? false,
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
  const notices = showNotices({
    supported: Notification.isSupported(),
    create: (notice) => new Notification(notificationOptions(notice, process.platform)),
    clicked: (window: BrowserWindow, id) => {
      if (window.isDestroyed()) return
      if (window.isMinimized()) window.restore()
      window.show()
      if (process.platform === "darwin") app.focus({ steal: true })
      window.focus()
      window.webContents.send(noticeClickChannel, id)
    },
  })
  // A window whose page shows notices or a badge takes them away with it when that page
  // goes, as it closes, crashes or loads again, since no page is left to take them back.
  const tended = new WeakSet<BrowserWindow>()
  const tend = (window: BrowserWindow): void => {
    if (tended.has(window)) return
    tended.add(window)
    const reset = (): void => {
      notices.closeAll()
      badgeOf(window, { count: 0, image: null })
    }
    window.on("closed", reset)
    window.webContents.on("render-process-gone", reset)
    // Once a new page commits, as a reload: a navigation `will-navigate` cancels, as a file
    // dropped on the window, leaves the page and what it showed.
    window.webContents.on("did-navigate", reset)
  }
  registerNoticeIpc(ipcMain, {
    window: appWindow,
    show: (window, notice) => {
      tend(window)
      notices.show(window, notice)
    },
    close: notices.close,
  })
  // The page asks whether the system holds notifications back before it plays its sound. The
  // system's programs are asked in the environment they expect, outside an AppImage's mount.
  const systemQuiet = platformQuiet(
    process.platform,
    installedEnvironment(process.env, appImageMounts()),
    undefined,
    windowsProbe(ntdllQuery(), (error) =>
      warnings("quiet")("Focus Assist could not be read", error),
    ),
  )
  registerQuietIpc(ipcMain, { window: appWindow, quiet: systemQuiet.quiet })
  // The page's feedback notes are posted from here, never from the page.
  if (feedbackTo) {
    registerFeedbackIpc(ipcMain, {
      window: appWindow,
      about: feedbackDetails,
      send: (note) =>
        sendFeedback(note, {
          origin: feedbackTo,
          about: feedbackDetails(),
          fetch: (url, init) => net.fetch(url, init),
        }),
    })
  }
  // Asked once now, so the first ring is not answered by the default.
  systemQuiet.warm()
  // The page's Inbox count on the app's icon: the dock or launcher badge, or on Windows
  // the taskbar overlay.
  registerBadgeIpc(ipcMain, {
    window: appWindow,
    apply: (window: BrowserWindow, badge) => {
      tend(window)
      badgeOf(window, badge)
    },
  })
  // The page asks for its window's focus when it starts listening, as when it loads again.
  registerWindowFocusIpc(ipcMain, { window: appWindow, request: tellWindowFocus })
  // The page learns of an update, can open the page of one it must install itself, and
  // chooses the releases the build follows.
  registerUpdateIpc(ipcMain, {
    window: (event) => appWindow(event)?.webContents,
    request: offers.request,
    openPage: () => {
      void updates
        .page()
        .then((url) => {
          if (url) return shell.openExternal(url)
        })
        .catch((error: unknown) =>
          log.warn("update.page-failed", "The release page did not open.", { err: error }),
        )
    },
    allow: () => void updates.allow(),
    channel: updates.channel,
    setChannel: (next) => {
      try {
        updates.setChannel(next)
      } catch (error) {
        log.warn("update.channel-not-kept", "The update channel was not kept.", { err: error })
      }
    },
  })
  // The page learns what is new after an update, once.
  registerWhatsNewIpc(ipcMain, {
    window: (event) => appWindow(event)?.webContents,
    whatsNew: news.whatsNew.whatsNew,
    dismiss: news.whatsNew.dismiss,
  })
  // The page learns whether this is a portable copy and may install the app from it,
  // while this copy keeps running, and is told how the install goes.
  const installer = portableInstaller({
    portable,
    version: app.getVersion(),
    run,
    dataFolder: shownPath(app.getPath("userData"), {
      platform: process.platform,
      home: homedir(),
    }),
    uncheckedAdvice:
      process.platform === "darwin"
        ? "Check the copy in your Applications folder, or reinstall Novadeck from the disk image."
        : process.platform === "win32"
          ? "Open the installed Novadeck from the Start menu, or uninstall it in Windows Settings and try again."
          : "Try again, or reinstall Novadeck with install.sh.",
    find: copies.installedCopies,
    install: copies.install,
    changed: (state) => {
      for (const page of appPages(appWindows())) {
        try {
          page.send(portableStateChannel, state)
        } catch (error) {
          log.warn("portable.send-failed", "The portable state was not sent to a window.", {
            err: error,
          })
        }
      }
    },
    stopping: () => quitting.stopping,
    log: warnings("portable"),
  })
  registerPortableIpc(ipcMain, {
    window: (event) => appWindow(event)?.webContents,
    log: warnings("portable"),
    installer,
  })
  // A portable copy's card opens the download page, shows the data folder and tells what is
  // new in the offered version.
  registerPortableLinksIpc(ipcMain, {
    window: (event) => appWindow(event)?.webContents,
    portable,
    openDownload: (url) => shell.openExternal(url),
    showDataFolder: () => {
      void shell.openPath(app.getPath("userData")).then((problem) => {
        if (problem !== "") warnings("portable")("The data folder did not open.", problem)
      })
    },
    news: news.offered,
    log: warnings("portable"),
  })
  // The page learns what removing this copy would do, removes it, and quits afterwards.
  registerUninstallIpc(ipcMain, {
    window: (event) => appWindow(event)?.webContents,
    uninstaller: machineUninstaller({
      portable,
      // Quitting as usual, less the install of a waiting update, which would put the app
      // back.
      shutdown: () => {
        quitting.stopping = true
        updates.installNothing()
        return shutDown()
      },
      stopping: () => quitting.stopping,
      log: warnings("uninstall"),
    }),
  })
  // The page learns whether Electron's sandbox is on, and how to turn it on if not.
  registerSandboxIpc(ipcMain, {
    window: appWindow,
    state: async () =>
      sandboxState(app.commandLine.hasSwitch("no-sandbox"), {
        platform: process.platform,
        repository: await releaseRepository(),
        restricted: await readFile(
          "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
          "utf8",
        ).catch(() => undefined),
        label: await readFile("/proc/self/attr/apparmor/current", "utf8").catch(() =>
          readFile("/proc/self/attr/current", "utf8").catch(() => undefined),
        ),
        env: process.env,
        home: homedir(),
        realpath: realpathOrUndefined,
      }),
  })
  // The page opens the logs folder, and reports the errors it didn't catch.
  registerLogIpc(ipcMain, {
    window: appWindow,
    openLogs,
    log: logger.for("page", "ui"),
  })
  // The app's page asks for pictures of its page views, agents' looks at pages, and phone
  // views.
  pages.registerIpc((event) => appWindow(event) !== undefined)
  // Only the app's own pages learn the version it runs.
  ipcMain.handle(versionChannel, (event) => (appWindow(event) ? app.getVersion() : ""))
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

  if (!app.isPackaged) await waitForUi(developmentOrigin)

  createWindow(server.origin)
  void updates
    .start()
    .catch((error: unknown) =>
      log.warn("update.start-failed", "Updates did not start.", { err: error }),
    )
}

app.setAppUserModelId(appId)
keepSpellcheckOffline(app)

// Any of the app's processes ending, the runner's utility process included: why, and its
// exit code, as a crash or the system's OOM killer leaves them.
app.on("child-process-gone", (_event, details) => {
  const data = goneData(details)
  if (goneBadly(details.reason))
    log.error("process.gone", "A process of the app ended unexpectedly.", { data })
  else log.info("process.gone", "A process of the app ended.", { data })
})

// What goes wrong with a window's page, as the page itself can't tell: it crashed, it hangs,
// it didn't load, or its preload failed.
const pageLog = logger.for("page", "ui")
// A webview's page is a browser pane's, not the app's: `contents` tells them apart.
app.on("render-process-gone", (_event, contents, details) => {
  const data = { reason: details.reason, exitCode: details.exitCode, contents: contents.getType() }
  // A page an agent's look loads out of sight is not the app's UI: its look says so.
  const window = BrowserWindow.fromWebContents(contents)
  if (window && looker.is(window))
    pageLog.warn("look.gone", "A page being looked at ended unexpectedly.", { data })
  else pageLog.error("ui.gone", "A page ended unexpectedly.", { data })
})

app.on("second-instance", () => {
  quitting.reopenWanted = rememberReopen(quitting.reopenWanted, quitting.stopping)
  const [window] = appWindows()
  if (window) bringForward(window)
  // On macOS the app lives on with no window, so a second launch has none to show; one
  // that is quitting opens none.
  else if (server && !quitting.stopping) createWindow(server.origin)
  if (process.platform === "darwin") app.focus({ steal: true })
})

app.whenReady().then(() => {
  if (!primaryInstance) return
  transcriptKey = loadKey()
  // A system shutdown quits, which saves every page and terminal before the shells end.
  quitOnShutdown(powerMonitor, updates.quitOnSessionEnd)
  // Ctrl+Q and the menu's Quit are the person's quit, which installs a waiting update; a
  // signal's is not. See ./window/menu.ts.
  if (process.platform === "linux")
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        linuxMenu(() => {
          quitting.orderly = true
          app.quit()
        }),
      ),
    )
  // macOS shows its menu bar: Help opens the logs folder. Elsewhere Preferences does.
  if (process.platform === "darwin")
    Menu.setApplicationMenu(Menu.buildFromTemplate(macMenu(openLogs)))
  limitPermissions(
    session.defaultSession,
    isAppPage,
    // macOS asks the person once, and remembers; elsewhere the page's own request is all.
    process.platform === "darwin"
      ? () => systemPreferences.askForMediaAccess("microphone")
      : undefined,
  )
  pages.watch(log, (contents) => watchAppPage(contents, pageLog))

  void launch().catch((error: unknown) => {
    log.fatal("host.launch-failed", "The app could not start.", { err: error })
    console.error(error)
    exitApp(1)
  })

  app.on("activate", () => {
    quitting.reopenWanted = rememberReopen(quitting.reopenWanted, quitting.stopping)
    if (appWindows().length === 0) {
      if (server && !quitting.stopping) createWindow(server.origin)
    }
  })
})

app.on("before-quit", (event) => {
  // The quit already under way ends the app once the update is in place.
  if (updates.holdsQuit()) return event.preventDefault()
  if (!quitting.stopping)
    log.info("app.quit", "The app is quitting.", { data: { orderly: quitting.orderly } })
  updates.quitBegins()
  if ((!server && !runner) || quitting.stopping) return

  event.preventDefault()
  quitting.stopping = true
  void shutDown()
    .then(updates.installMacUpdateOnQuit)
    .then(updates.openAppImageAfterQuit)
    .finally(() => app.quit())
})

app.on("window-all-closed", () => {
  quitting.orderly = true
  if (process.platform !== "darwin") app.quit()
})
