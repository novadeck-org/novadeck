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
import { rezoomPages } from "@novadeck/viewers/browser/host"
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
  screen,
  webContents,
  powerMonitor,
  safeStorage,
  session,
  shell,
  systemPreferences,
} from "electron"

import {
  apiUrlArgumentPrefix,
  directoryPickerChannel,
  extraWindowArgumentPrefix,
  feedbackArgumentPrefix,
  noticeClickChannel,
  portableStateChannel,
  projectWindowNavigateChannel,
  projectWindowsChannel,
  runnerPortChannel,
  versionChannel,
  tellsScreenReader,
  windowControlsSide,
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
import {
  beforeQuit,
  quitOnShutdown,
  saveBeforeClose,
  saveOnSessionEnd,
  savePages,
  shutDownInOrder,
  type QuitSteps,
} from "./quit.js"
import { notQuitting } from "./quitting.js"
import {
  developmentOrigin,
  murmurEngine,
  relayPath,
  releaseRepository,
  voiceEngine,
  waitForUi,
} from "./resources.js"
import { logRunnerEvents, startRunner, type RunnerEnd, type RunnerProcess } from "./runner.js"
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
import {
  keepCaption,
  keepControls,
  registerControlsIpc,
  type WindowControls,
} from "./window/controls.js"
import { registerWindowFocusIpc } from "./window/focus.js"
import { linuxMenu, macMenu, windowsMenu } from "./window/menu.js"
import { registerPanePictureIpc } from "./window/pane-pictures.js"
import { limitPermissions } from "./window/permissions.js"
import { registerProjectWindowsIpc } from "./window/project-windows-ipc.js"
import { createProjectWindows } from "./window/project-windows.js"
import {
  boundsToOpen,
  keepWindows,
  type SavedWindow,
  type SavedWindows,
} from "./window/saved-windows.js"
import { keepScale, registerScaleIpc } from "./window/scale.js"
import { atspiReaders, runIn } from "./window/screen-reader-linux.js"
import { electronReaders, registerScreenReaderIpc } from "./window/screen-reader.js"
import { keepSpellcheckOffline } from "./window/spellcheck.js"
import { clickNotice, createVoice, windowsToKeep } from "./window/voice.js"

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
// Each window's own controls where they sit in its page's header, on macOS and Windows.
const windowControls = new WeakMap<BrowserWindow, WindowControls>()
// The scale the person chose in Preferences, which every window shows, the next launch's
// first paint too.
const scale = keepScale(
  join(app.getPath("userData"), "scale.json"),
  () => appPages(appWindows()),
  (page) => {
    // Electron gives the views a page hosts its zoom whenever the page's changes.
    rezoomPages(page, webContents.getAllWebContents())
    // The window's controls stay on the header's middle, which the zoom moved.
    const window = BrowserWindow.fromWebContents(page)
    if (window) windowControls.get(window)?.apply()
  },
)
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
  startInstalledImage: copies.startInstalledImage,
})
// What is new after an update, and in the version a portable copy is offered.
const news = updateNewsOf({
  state: updateState,
  ranBefore,
  offeredVersion: offered,
  warn: (message, error) => updatesLog.warn(message, error),
})
// A portable launch giving way to a newer copy.
const portableCopies = portableLaunch({ copies, exitApp, log: warnings("portable") })

// The windows the next launch reopens, when the person has project windows on: each open
// window's project and bounds, kept as they change (see ./window/saved-windows.ts).
const savedWindows = keepWindows(join(app.getPath("userData"), "windows.json"))
const windowsSaveDelayMs = 400
let windowsTimer: ReturnType<typeof setTimeout> | undefined
// The open windows that show a project, as they stand.
const openWindows = (): SavedWindow[] =>
  projectWindows
    .list()
    .flatMap(({ window, projectId }): SavedWindow[] =>
      projectId === undefined || window.isDestroyed()
        ? []
        : [{ projectId, bounds: window.getNormalBounds(), maximized: window.isMaximized() }],
    )
// Keeps the open windows as they stand (see `windowsToKeep`: nothing once a quit is under way,
// whose closes are no one leaving a window, `before-quit` having kept them before it closes
// them, and none when the last window closed, which keeps the windows as they stood before it).
const rememberWindows = (): void => {
  clearTimeout(windowsTimer)
  windowsTimer = undefined
  const keep = windowsToKeep(openWindows(), quitting.stopping)
  if (keep) void savedWindows.remember(keep)
}
const rememberWindowsSoon = (): void => {
  clearTimeout(windowsTimer)
  windowsTimer = setTimeout(rememberWindows, windowsSaveDelayMs)
}

// Asks these windows' pages to finish their saves.
const saveWindows = (windows: readonly BrowserWindow[]): Promise<void> =>
  savePages(ipcMain, appPages(windows), {
    sender: (answer) => appWindow(answer)?.webContents,
    timeoutMs: saveBeforeQuitMs,
  })

// What quitting and the uninstall both run.
const shutDown = (): Promise<RunnerEnd> =>
  shutDownInOrder({
    platform: process.platform,
    persist: () => runner?.persist(),
    save: () => saveWindows(appWindows()),
    closeRunner: () => runner?.close(),
    closeServer: () => server?.close(),
  })

// The page's Inbox count on the app's icon, as this platform shows one.
const badgeOf = (window: BrowserWindow, badge: DesktopBadge): void =>
  applyBadge({ platform: process.platform, app, nativeImage, window }, badge)

// Only the window the person used last (the voice) raises notifications and counts on the
// app's icon, so two windows never double up (see ./window/voice.ts). `closeNotices` takes away
// what the app shows, once the notices exist.
let closeNotices: () => void = () => {}
const voiceBook = createVoice<BrowserWindow>({
  hasVoice: (window) => projectWindows.hasVoice(window),
  applyBadge: badgeOf,
  closeNotices: () => closeNotices(),
  alive: (window) => !window.isDestroyed(),
})
// How many windows the app has brought forward, which a notification's click watches.
let forwards = 0

// What each window shows and which the person used last, the project windows' book (see
// ./window/project-windows.ts). The windows' own pages hear of it, and the badge, the
// notifications and what the person clicks follow it.
const projectWindows = createProjectWindows<BrowserWindow>({
  create: (projectId) => createWindow(appOrigin(), { projectId, extra: true }),
  forward: (window) => {
    forwards += 1
    bringForward(window)
    if (process.platform === "darwin") app.focus({ steal: true })
  },
  tell: (window, state) => {
    if (window.isDestroyed() || !isAppPage(window.webContents.getURL())) return
    window.webContents.send(projectWindowsChannel, state)
  },
  navigate: (window, target) => {
    if (window.isDestroyed() || !isAppPage(window.webContents.getURL())) return
    window.webContents.send(projectWindowNavigateChannel, target)
  },
  voiceMoved: (from, to) => voiceBook.moved(from, to),
})
// The address the app's own server answers on, once it does.
const appOrigin = (): string => {
  if (!server) throw new Error("The app's server is not up yet.")
  return server.origin
}

// Opens a window on the app's page, whose preload learns the API's address, the WebGL
// context limit and whether the app sends feedback notes. `projectId` opens it on that
// project, `bounds` where it stood, and `extra` marks a window that is not the app's first,
// which leaves the one-time things to the first.
const createWindow = (
  origin: string,
  options: {
    readonly projectId?: string
    readonly extra?: boolean
    readonly bounds?: SavedWindow["bounds"]
    readonly maximized?: boolean
  } = {},
): BrowserWindow => {
  const apiUrl = new URL("/api/", origin).href
  const window = openAppWindow({
    ground: appearance.current()?.ground ?? "#ffffff",
    ink: appearance.current()?.ink,
    zoomFactor: scale.current(),
    preloadArguments: [
      `${apiUrlArgumentPrefix}${apiUrl}`,
      webglContextsArgument(webglContexts),
      ...(feedbackTo ? [`${feedbackArgumentPrefix}1`] : []),
      ...(options.extra ? [`${extraWindowArgumentPrefix}1`] : []),
    ],
    ...(options.bounds
      ? {
          bounds: boundsToOpen(
            options.bounds,
            screen.getAllDisplays().map((d) => d.workArea),
          ),
        }
      : {}),
    ...(options.maximized ? { maximized: true } : {}),
    // Any session and view will do: the page takes the project's own.
    ...(options.projectId
      ? { route: `/projects/${encodeURIComponent(options.projectId)}/sessions/_/_` }
      : {}),
  })
  projectWindows.add(window, options.projectId)
  window.on("focus", () => projectWindows.used(window))
  window.on("move", rememberWindowsSoon)
  window.on("resize", rememberWindowsSoon)
  window.on("closed", () => {
    // Whether it had the voice, as it did when it closed: its notifications go with it.
    const wasVoice = projectWindows.hasVoice(window)
    projectWindows.remove(window)
    voiceBook.closed(window, wasVoice, projectWindows.size())
    rememberWindows()
  })
  // Its page opens at the scale, and takes it again whenever it loads.
  window.webContents.on("dom-ready", () => scale.apply(window.webContents))
  const side = windowControlsSide(process.platform)
  if (side)
    windowControls.set(window, side === "start" ? keepControls(window) : keepCaption(window))
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

// Opens the app's windows at launch: with project windows on, those the last run had open,
// each on its project, the first as the app's own and the rest as extra ones; else one window.
const openFirstWindows = (origin: string, kept: SavedWindows): void => {
  const reopened = kept.on ? kept.windows : []
  if (reopened.length === 0) {
    createWindow(origin)
    return
  }
  reopened.forEach(({ projectId, bounds, maximized }, index) =>
    createWindow(origin, { projectId, bounds, maximized, extra: index > 0 }),
  )
}

const launch = async (): Promise<void> => {
  // The scale windows open at, read before the first one does.
  await scale.load()
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
      // Windows' caption buttons draw in the page's ink.
      if (next.ink) windowControls.get(window)?.paint(next.ink)
      void appearance.save(next)
    },
  })
  // The page's notices about its terminals, as the system's notifications; a click brings
  // the window to the front and tells its page which terminal to show.
  const notices = showNotices({
    supported: Notification.isSupported(),
    create: (notice) => new Notification(notificationOptions(notice, process.platform)),
    clicked: (window: BrowserWindow, id) =>
      clickNotice({
        windowsOn: savedWindows.current().on,
        raising: window,
        voice: projectWindows.voice(),
        alive: (each) => !each.isDestroyed(),
        send: (target) => target.webContents.send(noticeClickChannel, id),
        forward: (target) => {
          forwards += 1
          bringForward(target)
          if (process.platform === "darwin") app.focus({ steal: true })
        },
        forwards: () => forwards,
        later: (run, ms) => void setTimeout(run, ms),
      }),
  })
  closeNotices = notices.closeAll
  // A window whose page shows notices or a badge takes them away with it when that page
  // goes, as it closes, crashes or loads again, since no page is left to take them back.
  const tended = new WeakSet<BrowserWindow>()
  const tend = (window: BrowserWindow): void => {
    if (tended.has(window)) return
    tended.add(window)
    const reset = (): void => voiceBook.reset(window)
    window.webContents.on("render-process-gone", reset)
    // Once a new page commits, as a reload: a navigation `will-navigate` cancels, as a file
    // dropped on the window, leaves the page and what it showed.
    window.webContents.on("did-navigate", reset)
  }
  registerNoticeIpc(ipcMain, {
    window: appWindow,
    show: (window, notice) => {
      if (!voiceBook.mayRaise(window)) return
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
      voiceBook.counted(window, badge)
    },
  })
  // The pages' project windows: what each shows, opening one for a project, swapping two
  // windows' projects, and handing a place in a project to its window.
  registerProjectWindowsIpc(ipcMain, {
    window: appWindow,
    ask: (window) => projectWindows.tell(window),
    show: (window, projectId, known) => {
      projectWindows.show(window, projectId, known)
      rememberWindowsSoon()
    },
    use: (on) => void savedWindows.use(on).then(rememberWindows),
    open: (window, projectId) => projectWindows.open(window, projectId),
    swap: (window, projectId) => {
      projectWindows.swap(window, projectId)
      rememberWindowsSoon()
    },
    handOff: (window, target) => projectWindows.handOff(window, target),
  })
  // The page asks for its window's focus when it starts listening, as when it loads again.
  registerWindowFocusIpc(ipcMain, { window: appWindow, request: tellWindowFocus })
  // The page sets the window's controls on its header's middle, or hides them, as in Zen
  // (macOS and Windows; on Linux the window keeps the system's title bar and nothing listens).
  if (windowControlsSide(process.platform))
    registerControlsIpc(ipcMain, (event) => {
      const window = appWindow(event)
      return window && windowControls.get(window)
    })
  registerScaleIpc(
    ipcMain,
    (event) => appWindow(event) !== undefined,
    (value) => void scale.set(value),
  )
  // The page asks whether a screen reader runs when it starts listening, and hears of each
  // change: its terminals keep a reader's text only while one may (terminal-views). Electron
  // tells on macOS and Windows; on Linux the desktop's accessibility bus does, read with the
  // system's own gdbus, outside an AppImage's mount.
  if (tellsScreenReader(process.platform)) {
    const systemEnv = installedEnvironment(process.env, appImageMounts())
    const readers =
      process.platform === "linux" ? atspiReaders({ run: runIn(systemEnv) }) : electronReaders(app)
    const stopReaders = registerScreenReaderIpc(ipcMain, readers, {
      page: (event) => appWindow(event)?.webContents,
      pages: () => appPages(appWindows()),
    })
    process.once("exit", stopReaders)
  }
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
    restart: () =>
      void updates
        .restart()
        .catch((error: unknown) =>
          log.warn("update.restart-failed", "The restart into the update failed.", { err: error }),
        ),
    channel: updates.channel,
    setChannel: (next) =>
      updates.setChannel(next, (error) =>
        log.warn("update.channel-not-kept", "The update channel was not kept.", { err: error }),
      ),
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
    news: news.offeredNews,
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
  // And pictures of its own companion panes, to stand in while each builds again.
  registerPanePictureIpc(ipcMain, (event) => appWindow(event) !== undefined)
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
  const started = await startHttpServer({
    port: 0,
    origins: app.isPackaged ? ["null"] : [developmentOrigin],
  })
  // A quit that came while the app started closed what had started by then: what starts
  // after it closes too, and no window opens on a runner that is gone.
  if (quitting.stopping) {
    // A server that fails to close is no failed launch: the quit goes on regardless.
    await started
      .close()
      .catch((error: unknown) =>
        log.warn("server.close-failed", "The app's server did not close.", { err: error }),
      )
    return
  }
  server = started

  if (!app.isPackaged) await waitForUi(developmentOrigin)
  if (quitting.stopping) return

  // With project windows on, the windows the last run had open open again, each on its
  // project; the first as the app's own, the rest as extra ones.
  openFirstWindows(server.origin, await savedWindows.load())
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
  const window = projectWindows.voice() ?? appWindows()[0]
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
  if (process.platform === "win32") Menu.setApplicationMenu(Menu.buildFromTemplate(windowsMenu))
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

const quitSteps: QuitSteps = {
  quitting,
  held: updates.holdsQuit,
  announce: () =>
    log.info("app.quit", "The app is quitting.", { data: { orderly: quitting.orderly } }),
  begin: updates.quitBegins,
  hosting: () => Boolean(server || runner),
  shutDown,
  installMacUpdate: updates.installMacUpdateOnQuit,
  reopenAppImage: updates.openAppImageAfterQuit,
  reopenCurrent: updates.openCurrentAfterQuit,
  keepUpdate: updates.keepUpdateOnQuit,
  quit: () => app.quit(),
}
app.on("before-quit", (event) => {
  // The windows as they stand, before the quit closes them.
  rememberWindows()
  void beforeQuit(event, quitSteps)
})

app.on("window-all-closed", () => {
  quitting.orderly = true
  if (process.platform !== "darwin") app.quit()
})
