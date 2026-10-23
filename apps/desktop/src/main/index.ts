import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { accessSync, existsSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import {
  access,
  constants,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir, release } from "node:os"
import { basename, dirname, join, win32 } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { consoleLogger, logPath, openSession, type Logger, type Session } from "@novadeck/log"
import type { DesktopBadge, UpdateChannel } from "@novadeck/protocol/bridge"
import { pagesPartition } from "@novadeck/protocol/pages"
import { startHttpServer, type HttpServer } from "@novadeck/runner/http"
import {
  attachPage,
  countSignIns,
  guardPage,
  lockPagesSession,
  pagesSession,
  passkeyLabels,
  pickPasskeys,
  picturePage,
  watchPageRequests,
  webAddress,
} from "@novadeck/viewers/browser/host"
import { pageSignInChannel } from "@novadeck/viewers/browser/sign-in"
import { pageRequestChannel } from "@novadeck/viewers/browser/trouble"
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
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
  webContents,
} from "electron"

import {
  apiUrlArgumentPrefix,
  directoryPickerChannel,
  noticeClickChannel,
  pagePictureChannel,
  portableStateChannel,
  runnerPortChannel,
  versionChannel,
  windowFocusChannel,
} from "../bridge.js"
import { openProcessLog, saltFileIn, type LogSetup } from "../logging.js"
import { keepAppearance, registerAppearanceIpc } from "./appearance.js"
import {
  bundleVersionOf,
  findInstalledApps,
  installBundle,
  isNewerVersion,
  recoverBundles,
  relaunchIntoCopy,
} from "./applications-folder.js"
import { applyBadge, registerBadgeIpc } from "./badge.js"
import { dataFolderName, logsFolder } from "./data-folder.js"
import { detectSoftwareGraphics } from "./graphics.js"
import {
  extractWithProcess,
  findInstalled,
  installAppImage,
  installLayout,
} from "./install-linux.js"
import { isInstalledImage } from "./install-location.js"
import {
  findInstalledWindows,
  hashBody,
  insideInstallFolder,
  installedAtLeast,
  installedByInstaller,
  legacyPrefixFolder,
  readLegacyUninstaller,
  powershellUsable,
  prepareSetup,
  readInstallRecord,
  reportPercents,
  runSetup,
  SetupBusyError,
  setupResult,
  setupName,
  startDetached,
  type InstallRecord,
} from "./install-windows.js"
import {
  goneBadly,
  goneData,
  installKind,
  logNewDumps,
  logRunnerOutput,
  registerLogIpc,
  updateLogOn,
} from "./logs.js"
import {
  allowMacUpdates,
  InstallPostponed,
  installMacUpdate,
  recheckMacUpdate,
  macSwapMode,
  prepareMacUpdate,
  removeMacUpdates,
  UpdateRejected,
} from "./mac-update.js"
import { linuxMenu, macMenu } from "./menu.js"
import { notificationText, registerNoticeIpc, showNotices } from "./notices.js"
import { limitPermissions, ownPage } from "./permissions.js"
import {
  installedEnvironment,
  leaveForNewerInstalled,
  portableInstaller,
  redirectMarker,
  registerPortableIpc,
  type InstallStep,
  type PlatformInstall,
  startAppImage,
} from "./portable.js"
import { quitOnShutdown, saveBeforeClose, saveOnSessionEnd, savePages } from "./quit.js"
import { startRunner, type RunnerEvents, type RunnerHost } from "./runner.js"
import { registerSandboxIpc, sandboxState } from "./sandbox.js"
import { loadTranscriptKey } from "./transcript-key.js"
import { registerUninstallIpc, startRemovalAfterExit, uninstaller } from "./uninstall.js"
import {
  releaseDownloadsUrl,
  releaseLatestUrl,
  releasePageUrl,
  releaseRepositoryOf,
} from "./update-release.js"
import { installOutcome, keepUpdateState } from "./update-state.js"
import {
  bundleOf,
  checkForUpdates,
  developerIdSigned,
  installOnlyOnOrderlyQuit,
  portableOf,
  quitWithoutInstalling,
  registerUpdateIpc,
  trackOffer,
  updatePlan,
  type Updater,
  type UpdateBuild,
  type UpdaterKind,
} from "./updater.js"
import { keepWhatsNew, registerWhatsNewIpc, whatsNewAtLaunch } from "./whats-new.js"
import { registerWindowFocusIpc } from "./window-focus.js"

const appId = "dev.mzpk.novadeck"
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

// Names this launch in every line of both logs, the host's and the runner's; never kept.
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
// The host's log: host.log, written by this, the primary instance, alone.
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
      file: logPath(app.getPath("logs"), "host"),
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
  log.fatal("host.uncaught", "The host hit an error nothing caught.", {
    data: { origin },
    err: error,
  }),
)
process.on("unhandledRejection", (reason) => {
  log.error("host.rejection", "A promise in the host failed with nothing to catch it.", {
    err: reason,
  })
  console.error("Unhandled rejection:", reason)
})
process.on("exit", (code) => {
  records?.end({ code })
  logger.close()
})

const developmentOrigin = "http://127.0.0.1:5173"
// How long quitting waits for the pages' last saves.
const saveBeforeQuitMs = 1_500
const currentDirectory = dirname(fileURLToPath(import.meta.url))

// The page's last appearance, which new windows open on so a dark theme never flashes
// white.
const appearance = keepAppearance(join(app.getPath("userData"), "appearance.json"))

// What the host remembers about updating: the channel, a failed install, how long this copy is behind.
const updateState = keepUpdateState(join(app.getPath("userData"), "update.json"))
// Whether the app ran in this data folder before this launch, which the runner's database
// shows: it is made when the first launch starts the runner and never removed, and older
// builds, which kept no last-run version, made it too. Read here, before the runner starts,
// so this launch's own database doesn't count; see `whatsNewAtLaunch`.
const ranBefore = existsSync(join(app.getPath("userData"), "workspace.sqlite"))
// The log of updating, in the host's log; see `updateLogOn` in ./logs.ts.
const updatesLog = updateLogOn(logger.for("updates"))
// The macOS update made ready to put in place on quitting, and whether quitting puts it
// there: a quit as the session ends, or the uninstall, switches that off. See ./mac-update.ts.
let macUpdate: { readonly version: string; readonly prepared: string } | undefined
const macQuitInstall = { autoInstallOnAppQuit: true }

let server: HttpServer | undefined
let runner: RunnerHost | undefined
let stopping = false
// Names this run of the app; see `PortableHost.run`.
const run = randomUUID()
// Whether the quit under way began the orderly way: closing the last window, or
// the menu's Quit. On Linux Electron turns SIGTERM, SIGINT and SIGHUP into an
// ordinary quit, which must not install an update; see ./updater.ts.
let orderlyQuit = false
// The auto-updater of a build that looks for updates, once it has loaded, and what keeps
// its schedule.
let updater: Updater | undefined
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

/**
 * The relay agents start for Novadeck's MCP server and hooks: shipped beside the UI, or built
 * in the relay's package, which the host's dependency on it finds wherever its folder is.
 */
const relayPath = (): string => {
  const name = process.platform === "win32" ? "novadeck-relay.exe" : "novadeck-relay"
  if (app.isPackaged) return join(process.resourcesPath, "relay", name)
  const relay = createRequire(join(app.getAppPath(), "package.json")).resolve("@novadeck/relay")
  return join(dirname(relay), "dist", name)
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
 * `pnpm build:engine` leaves in engines/whisper; and the folder or address its
 * archive is downloaded from, which is the release this build came from once packaged,
 * in the repository app-update.yml names. Without one the source is empty, and installing
 * the engine fails rather than download from a guess.
 */
const voiceEngine = async (): Promise<{ engine: string; source: string }> => {
  if (!app.isPackaged) {
    const dist = join(app.getAppPath(), "..", "..", "engines", "whisper", "dist")
    return { engine: join(dist, "engine.json"), source: dist }
  }
  const repository = process.env.NOVADECK_VOICE_SOURCE ? undefined : await releaseRepository()
  return {
    engine: join(process.resourcesPath, "voice", "engine.json"),
    // NOVADECK_VOICE_SOURCE points a build at another folder or address, as a local or
    // pull request build needs: it has no release of its own to download from.
    source:
      process.env.NOVADECK_VOICE_SOURCE ||
      (repository && releaseDownloadsUrl(repository, app.getVersion())) ||
      "",
  }
}

/**
 * Where murmur finds its engine, as `voiceEngine` does for voice input: the manifest
 * shipped beside the UI, or the one `pnpm build:engine` leaves in engines/murmur,
 * and the release this build came from once packaged.
 */
const murmurEngine = async (): Promise<{ murmurEngine: string; murmurSource: string }> => {
  if (!app.isPackaged) {
    const dist = join(app.getAppPath(), "..", "..", "engines", "murmur", "dist")
    return { murmurEngine: join(dist, "engine.json"), murmurSource: dist }
  }
  const repository = process.env.NOVADECK_MURMUR_SOURCE ? undefined : await releaseRepository()
  return {
    murmurEngine: join(process.resourcesPath, "murmur", "engine.json"),
    // NOVADECK_MURMUR_SOURCE points a build at another folder or address, as a local or
    // pull request build needs: it has no release of its own to download from.
    murmurSource:
      process.env.NOVADECK_MURMUR_SOURCE ||
      (repository && releaseDownloadsUrl(repository, app.getVersion())) ||
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
// once, as the update plan asks.
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

// The canonical form of a path, or undefined when it cannot be had.
const realpathOrUndefined = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

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
  }
}

// What `reg query` says of the value `name` under `key`; "" where the key is not there, an
// error where the registry could not be asked.
const queryRegistry = (key: string, name: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe"),
      ["query", key, "/v", name],
      { timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (!error) return resolve(stdout)
        // reg exits 1 for a key or value that does not exist.
        const code: unknown = (error as { code?: unknown }).code
        return code === 1 ? resolve("") : reject(error)
      },
    )
  })

// What the Windows installer recorded of an installed copy; see `readInstallRecord`.
const installRecord = (): Promise<InstallRecord> => readInstallRecord(appId, queryRegistry)

// The folder the Windows installer puts the app in unless told otherwise.
const defaultInstallFolder = (): string | undefined =>
  process.env.LOCALAPPDATA
    ? win32.join(process.env.LOCALAPPDATA, "Programs", "novadeck")
    : undefined

// Whether the NSIS installer made this Windows copy; see `installedByInstaller`. The
// registry is asked only when the uninstaller beside the executable does not settle it.
const windowsInstalled = async (): Promise<boolean> => {
  const defaultFolder = defaultInstallFolder()
  const by = (recorded: string | undefined): boolean =>
    installedByInstaller({
      execPath: process.execPath,
      recorded,
      defaultFolder,
      exists: existsSync,
    })
  if (by(undefined)) return true
  const record = await installRecord().catch(() => undefined)
  return by(record?.location)
}

// What decides how this build updates, but for the signature, read once. The signature
// takes a moment to ask, which a launch need not wait for to tell whether it is portable.
let base: Promise<Omit<UpdateBuild, "signed">> | undefined
const baseBuild = (): Promise<Omit<UpdateBuild, "signed">> =>
  (base ??= (async () => {
    const appDir = process.env.APPDIR
    const linux = process.platform === "linux"
    const appImage = process.env.APPIMAGE
    return {
      packaged: app.isPackaged,
      version: app.getVersion(),
      platform: process.platform,
      execPath: process.execPath,
      // The AppImage mounts under TMPDIR, which may reach it through a symlink; the
      // executable's path is the real one.
      env: { ...process.env, APPDIR: appDir && (await realpath(appDir).catch(() => appDir)) },
      inApplications: process.platform === "darwin" && app.isInApplicationsFolder(),
      bundleSwap:
        process.platform === "darwin" && app.isInApplicationsFolder()
          ? await macSwapMode(bundleOf(app.getPath("exe")))
          : undefined,
      appImageWritable: linux && (await appImageWritable()),
      windowsInstalled: process.platform === "win32" && (await windowsInstalled()),
      appImageInstalled:
        linux &&
        appImage !== undefined &&
        isInstalledImage(appImage, {
          env: process.env,
          home: homedir(),
          realpath: realpathOrUndefined,
        }),
    }
  })())

// What decides how this build updates, read once.
let build: Promise<UpdateBuild> | undefined
const updateBuild = (): Promise<UpdateBuild> =>
  (build ??= (async () => {
    const rest = await baseBuild()
    // Asked only where it matters: codesign takes a moment, and a portable copy only
    // tells of updates whether it is signed or not.
    return { ...rest, signed: checksSignature() && rest.inApplications && (await bundleSigned()) }
  })())

// A failure of updating, kept in the log, which a development run also shows on the console.
const updateWarning = (message: string, error: unknown): void => updatesLog.warn(message, error)

// Marks a failed install, so its release is told of rather than installed again.
// Synchronous: a failed install on quit is reported as the app exits.
const installFailed = (version: string): void => {
  try {
    updateState.recordInstallFailure(version)
  } catch (error) {
    updateWarning("The failed install was not kept.", error)
  }
}

// Marks the version an install on quitting begins to put in place, for the next launch
// to check; see `settleLastInstall`. Synchronous, as the app is exiting.
const recordInstalling = (version: string): void => {
  updatesLog.info(`Installing ${version} on quitting.`)
  try {
    updateState.recordInstalling(version)
  } catch (error) {
    updateWarning("The install begun was not kept.", error)
  }
}

// What the install the last quit began came to: one that left this launch older than the
// version it put in place failed, as when the Windows installer failed after the app
// exited, so it is marked like any failed install and told of rather than tried again
// at every launch. See `installOutcome`.
const settleLastInstall = (): void => {
  const { installing } = updateState.read()
  const outcome = installOutcome({ installing }, app.getVersion(), isNewerVersion)
  if (outcome === undefined || installing === undefined) return
  try {
    if (outcome === "failed") {
      updatesLog.warn(`Installing ${installing} did not take: this is still ${app.getVersion()}.`)
      updateState.recordInstallFailure(installing)
    } else {
      updatesLog.info(`Installed ${app.getVersion()}.`)
      updateState.clearInstalling()
    }
  } catch (error) {
    updateWarning("The last install was not settled.", error)
  }
}

// What the person is shown once after an update; see ./whats-new.ts. The launch is settled
// first, once, and the page's request waits for it.
let whatsNewLaunch: Promise<void> | undefined
const settleWhatsNewLaunch = (): Promise<void> =>
  (whatsNewLaunch ??= (async () => {
    const repository = await releaseRepository()
    const state = updateState.read()
    const settled = whatsNewAtLaunch(
      {
        previous: state.lastRunVersion,
        current: app.getVersion(),
        pending: state.whatsNewPending,
        from: state.whatsNewFrom,
        settled: state.whatsNewSettled,
        ranBefore,
        offerable: repository !== undefined,
      },
      isNewerVersion,
    )
    if (settled) updateState.recordLaunch(settled.lastRunVersion, settled.pending, settled.from)
  })().catch((error: unknown) => updateWarning("The launch was not recorded.", error)))
const whatsNew = keepWhatsNew({
  version: app.getVersion(),
  launched: settleWhatsNewLaunch,
  pending: () => updateState.read().whatsNewPending,
  from: () => updateState.read().whatsNewFrom,
  clear: () => updateState.settleWhatsNew(app.getVersion(), isNewerVersion),
  checkedAt: () => updateState.read().whatsNewCheckedAt,
  recordCheck: (time) => updateState.recordWhatsNewCheck(time),
  now: Date.now,
  repository: releaseRepository,
  fetch: (url, init) => net.fetch(url, init),
  newer: isNewerVersion,
  log: updateWarning,
})

// The macOS download being made ready, so one finished after a newer one began is let go.
let preparing = 0
// How long what an update left must sit unchanged before it is removed, as another copy
// on its own data folder may be installing from it.
const preparedForMs = 10 * 60 * 1000
// Whether the person turned down letting this copy install updates, which then offers the
// release page for the rest of the run; see `allowUpdates`.
let allowDeclined = false

// Starts checking for updates in a build that looks for them; see ./updater.ts.
const startUpdates = async (): Promise<void> => {
  const plan = updatePlan(await updateBuild())
  if (!plan) return
  // A copy that only tells, such as a portable one sharing this data folder, leaves the
  // installed copy's install for it to settle.
  if (plan.mode === "install") settleLastInstall()
  const state = updateState.read()
  updatesLog.info(
    `Novadeck ${app.getVersion()} ${plan.mode === "install" ? "installs" : "tells of"} updates on the ${channel} channel.`,
  )
  // What earlier launches prepared, and the app an install replaced, go before anything
  // new is prepared.
  if (plan.kind === "mac")
    await removeMacUpdates({ bundle: bundleOf(app.getPath("exe")), olderThanMs: preparedForMs })
  const current = await loadUpdater(plan.kind)
  const repository = await releaseRepository()
  updater = current
  updates = checkForUpdates(current, {
    mode: plan.mode,
    channel,
    failedVersion: state.installFailedOn,
    allow: plan.allow,
    // Checks go through novadeck.dev, which counts active copies, and fall back to GitHub.
    // Without a repository to fall back to they stay on the updater's own configuration.
    feed: repository && {
      repository,
      site: process.env.NOVADECK_UPDATE_URL,
      facts: {
        version: app.getVersion(),
        build: portableOf({ ...(await baseBuild()), signed: false }) ? "portable" : "installed",
      },
    },
    // macOS updates are put in place by the host as the app quits; the others install
    // from electron-updater's file.
    prepare:
      plan.kind === "mac"
        ? async ({ version, file }) => {
            // Once quitting, the update being put in place is left alone.
            if (stopping) return
            const turn = (preparing += 1)
            const prepared = await prepareMacUpdate({
              zip: file,
              version,
              bundle: bundleOf(app.getPath("exe")),
            })
            if (turn !== preparing || stopping) {
              await rm(dirname(prepared), { recursive: true, force: true }).catch(() => {})
              return
            }
            macUpdate = { version, prepared }
            updatesLog.info(`${version} is ready to install on quitting.`)
            await removeMacUpdates({ keep: prepared, olderThanMs: preparedForMs })
          }
        : undefined,
    rejected: (error) => error instanceof UpdateRejected,
    // An updater replaced, as by allowing updates, says nothing more.
    offer: (offer) => {
      if (updater !== current) return
      offers.offer(
        allowDeclined && offer.kind === "available"
          ? { kind: offer.kind, version: offer.version }
          : offer,
      )
    },
    installStarted: recordInstalling,
    installFailed,
    log: updateWarning,
    logger: updatesLog.logger,
  })
}

// Whether the macOS update is going into place, which a second quit, as a logout's, waits
// for: the app it ends would be left between the old bundle and the new.
let macInstalling = false

// On macOS, puts the update made ready in place as the app quits, once every page has
// saved and the shells have ended, so the next launch, however soon, is the new version.
// Should it fail, the old app is left whole and the release is told of from then on.
const installMacUpdateOnQuit = async (): Promise<void> => {
  const update = macUpdate
  if (process.platform !== "darwin" || !update || !macQuitInstall.autoInstallOnAppQuit) return
  if (!existsSync(update.prepared))
    return updatesLog.warn(`${update.version} was no longer ready to install; it downloads again.`)
  const bundle = bundleOf(app.getPath("exe"))
  // A bundle replaced while the app ran, as by install.sh, is not this build to replace.
  const plist = await readFile(join(bundle, "Contents", "Info.plist"), "utf8").catch(() => "")
  if (bundleVersionOf(plist) !== app.getVersion())
    return updatesLog.warn(`${update.version} was not installed: the app changed while it ran.`)
  const mode = await macSwapMode(bundle)
  if (mode === undefined)
    return updatesLog.warn(`${update.version} was not installed: the app can't be written.`)
  macInstalling = true
  try {
    try {
      await recheckMacUpdate({ prepared: update.prepared, bundle })
    } catch (error) {
      // Nothing was touched: one that could not be checked waits for a later session,
      // which prepares it again; one that no longer passes failed.
      if (error instanceof InstallPostponed) return updatesLog.warn(error.message)
      updateWarning("Installing the update failed.", error)
      return installFailed(update.version)
    }
    recordInstalling(update.version)
    try {
      await installMacUpdate({ prepared: update.prepared, bundle, mode })
      updatesLog.info(`Installed ${update.version}; it starts at the next launch.`)
    } catch (error) {
      updateWarning("Installing the update failed.", error)
      installFailed(update.version)
    }
  } finally {
    macInstalling = false
  }
}

// Lets this macOS copy install updates itself once an administrator hands its bundle to
// the person (see `allowMacUpdates`), then checks for updates afresh as a copy that
// installs. Only the copy whose offer says so asks, and one request at a time.
let allowing = false
const allowUpdates = async (): Promise<void> => {
  const offer = offers.current()
  if (process.platform !== "darwin" || allowing || offer?.kind !== "available" || !offer.allow)
    return
  allowing = true
  try {
    const allowed = await allowMacUpdates({
      bundle: bundleOf(app.getPath("exe")),
      uid: process.getuid?.() ?? -1,
      gid: process.getgid?.() ?? -1,
    })
    if (!allowed) {
      // Turned down, as by a person who has no administrator to ask: the chip leads to the
      // release page instead, for the rest of this run.
      allowDeclined = true
      offers.offer({ kind: "available", version: offer.version })
      return
    }
    updatesLog.info("An administrator let this copy install updates.")
    // The chip goes, as there is nothing left to press, until the download shows.
    offers.offer({ kind: "retrying", version: offer.version })
    updates?.stop()
    base = undefined
    build = undefined
    await startUpdates()
  } catch (error) {
    updateWarning("Letting this copy install updates failed.", error)
    offers.offer({ kind: "available", version: offer.version })
  } finally {
    allowing = false
  }
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
  () => (process.platform === "darwin" ? macQuitInstall : updater),
  () => app.quit(),
)

// The page's Inbox count on the app's icon, as this platform shows one.
const badgeOf = (window: BrowserWindow, badge: DesktopBadge): void =>
  applyBadge({ platform: process.platform, app, nativeImage, window }, badge)

// Tells a window's page whether the window has the system's focus; the page tracks it
// itself only while its own document does, not while focus is inside a frame of it.
const tellWindowFocus = (window: BrowserWindow): void => {
  if (window.isDestroyed()) return
  const contents = window.webContents
  if (contents.isDestroyed() || !isAppPage(contents.getURL())) return
  contents.send(windowFocusChannel, window.isFocused())
}

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
      // Live pages in the companion pane; see @novadeck/viewers/browser/host.
      webviewTag: true,
    },
  })

  window.once("ready-to-show", () => window.show())
  window.on("focus", () => tellWindowFocus(window))
  window.on("blur", () => tellWindowFocus(window))
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
    if (!attachPage(preferences, params, pagesPartition)) event.preventDefault()
  })

  if (app.isPackaged) {
    void window.loadFile(join(process.resourcesPath, "ui", "index.html"))
  } else {
    void window.loadURL(developmentOrigin)
  }

  return window
}

// The bundle names an installed copy may have: the running one's, and the packaged name,
// which is the executable's (`executableName` in electron-builder.yml) and survives a
// rename of the bundle.
const installedNames = (): string[] => [
  basename(bundleOf(app.getPath("exe"))),
  `${basename(app.getPath("exe"))}.app`,
]

// Runs a system tool, rejecting with its error, including what it wrote to stderr.
const runTool = (file: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 300_000 }, (error, _stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(),
    )
  })

// Whether the person can write to `path`.
const canWrite = (path: string): Promise<boolean> =>
  access(path, constants.W_OK).then(
    () => true,
    () => false,
  )

// The macOS install: this bundle copied into Applications while the app keeps running; see
// `installBundle`.
const bundleMachine = () => ({
  packaged: `${basename(app.getPath("exe"))}.app`,
  applications: "/Applications",
  userApplications: join(homedir(), "Applications"),
  exists: (path: string) =>
    access(path).then(
      () => true,
      () => false,
    ),
  rename,
  remove: (path: string) => rm(path, { recursive: true, force: true }),
  log: warnings("install"),
})

const installMacBundle = async (
  target: string | undefined,
  progress: (step: InstallStep) => void,
): Promise<PlatformInstall> => {
  progress({ phase: "installing" })
  return installBundle(target, {
    ...bundleMachine(),
    running: bundleOf(app.getPath("exe")),
    version: app.getVersion(),
    versionOf: (path) =>
      readFile(join(path, "Contents", "Info.plist"), "utf8").then(bundleVersionOf, () => undefined),
    writable: canWrite,
    mkdir: async (folder) => void (await mkdir(folder, { recursive: true })),
    ditto: (source, destination) => runTool("/usr/bin/ditto", [source, destination]),
    unquarantine: (path) => runTool("/usr/bin/xattr", ["-dr", "com.apple.quarantine", path]),
  })
}

// Starts the macOS app bundle `image` in place of this one; see `relaunchIntoCopy`. Nothing
// has to be let go first: the relaunch happens as this process ends.
const startBundle = (image: string): Promise<boolean> =>
  Promise.resolve(
    relaunchIntoCopy({
      executable: join(image, "Contents", "MacOS", basename(app.getPath("exe"))),
      exists: existsSync,
      relaunch: (execPath) => app.relaunch({ execPath }),
      exit: () => exitApp(0),
      log: warnings("install"),
    }),
  )

// The folder this copy's AppImage is mounted at, as the runtime names it and as it resolves.
const appImageMounts = (): string[] => {
  const mount = process.env.APPDIR
  return mount ? [mount, realpathOrUndefined(mount) ?? mount] : []
}

// Starts the AppImage at `image` in place of this process; see `startAppImage`.
const startInstalled = (image: string): Promise<boolean> =>
  startAppImage({
    image,
    env: process.env,
    mounts: appImageMounts(),
    spawn,
    runnable: (path) => {
      try {
        accessSync(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    releaseLock: () => app.releaseSingleInstanceLock(),
    reclaimLock: () => app.requestSingleInstanceLock(),
    exit: () => exitApp(0),
    log: warnings("install"),
  })

// Starts the installed Windows copy `image` in place of this process; see `startDetached`.
const startWindowsCopy = (image: string): Promise<boolean> =>
  startDetached({
    file: image,
    cwd: dirname(image),
    spawn,
    exists: existsSync,
    releaseLock: () => app.releaseSingleInstanceLock(),
    reclaimLock: () => app.requestSingleInstanceLock(),
    exit: () => exitApp(0),
    log: warnings("install"),
  })

// Starts the installed copy `image` in place of this one, the way this system does.
const startInstalledCopy = (image: string): Promise<boolean> =>
  process.platform === "darwin"
    ? startBundle(image)
    : process.platform === "win32"
      ? startWindowsCopy(image)
      : startInstalled(image)

// Tells the person that the installed copy at `image` would not start, which leaves the
// app with nothing to do but quit.
const alertNotStarted = async (image: string): Promise<void> => {
  await dialog.showMessageBox({
    type: "error",
    message: "The installed Novadeck did not start.",
    detail:
      process.platform === "darwin"
        ? `Open it from your Applications folder. It is at ${image}.`
        : process.platform === "win32"
          ? `Open it from the Start menu. It is at ${image}.`
          : `Start it from your applications menu or with the novadeck command. It is at ${image}.`,
  })
}

// The text of `url`, fetched with a time limit; undefined for a 404, and a throw for
// anything else but 200.
const fetchText = async (url: string): Promise<string | undefined> => {
  const response = await net.fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`)
  return response.text()
}

// Where the setup is downloaded to: one folder in the user's temporary folder, emptied
// before each download, so no more than one setup is ever kept.
const setupFolder = (): string => join(app.getPath("temp"), "novadeck-setup")

// How long a download may go without data before it is given up.
const downloadStallMs = 60_000

// Downloads `url` into the setup folder, hashing as it goes. The file is written by this
// app, so it carries no Mark of the Web; the hash is what vouches for it.
const downloadSetup = async (
  url: string,
  maxBytes: number,
  size: number | undefined,
  progress: (percent: number) => void,
): Promise<{ file: string; sha512: string }> => {
  const folder = setupFolder()
  try {
    await rm(folder, { recursive: true, force: true })
  } catch (error) {
    // An earlier setup still runs from the folder.
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES")
      throw new SetupBusyError("The setup folder is in use.", { cause: error })
    throw error
  }
  await mkdir(folder, { recursive: true })
  const file = join(folder, setupName)
  // Through Electron's network stack, which honours the system and PAC proxies as the
  // update check does. The download is given up only when no data comes for a while, so a
  // slow link is not cut off.
  const controller = new AbortController()
  let stall: ReturnType<typeof setTimeout> | undefined
  const alive = (): void => {
    clearTimeout(stall)
    stall = setTimeout(() => controller.abort(), downloadStallMs)
  }
  alive()
  const handle = await open(file, "w")
  try {
    const response = await net.fetch(url, { signal: controller.signal })
    // The release's size for the file; else what the server says it is sending.
    const length = Number(response.headers.get("content-length"))
    const report = reportPercents(size ?? (length > 0 ? length : undefined), progress)
    const sha512 = await hashBody(
      response as unknown as Parameters<typeof hashBody>[0],
      (chunk) => {
        alive()
        return handle.write(chunk).then(() => undefined)
      },
      maxBytes,
      report,
    )
    await handle.close()
    return { file, sha512 }
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(file, { force: true })
    throw error
  } finally {
    clearTimeout(stall)
  }
}

// LEGACY. Whether PowerShell passes the two tests of the old uninstaller's running-app check,
// as it would run them: its stub is 32-bit, so the 32-bit PowerShell is the one it finds.
const legacyInstallerPowerShell = (): Promise<boolean> => {
  const system = process.env.SystemRoot ?? "C:\\Windows"
  const wow = win32.join(system, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe")
  const file = existsSync(wow)
    ? wow
    : win32.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  return powershellUsable(
    (command) =>
      new Promise((resolve) => {
        execFile(file, ["-C", command], { timeout: 30_000, windowsHide: true }, (error) =>
          resolve(!error),
        )
      }),
  )
}

// How long the setup is waited for before the install is judged by what it left.
const setupWaitMs = 5 * 60_000

// The Windows install: the latest release's setup is downloaded and checked, then run
// silently while this copy keeps running, and the install is vouched for by the copy it
// leaves; see `prepareSetup` and docs/auto-update.md. The setup starts nothing.
const installWindowsSetup = async (
  progress: (step: InstallStep) => void,
): Promise<PlatformInstall> => {
  // The setup refuses to run while Novadeck runs from the install folder; say so up front
  // to a copy unpacked there.
  const record = await installRecord().catch(() => undefined)
  const folders = [record?.location, defaultInstallFolder()]
  if (insideInstallFolder(process.execPath, folders) !== undefined)
    return {
      kind: "failed",
      reason:
        "Novadeck can't install while this copy runs from its install folder. Move this copy somewhere else, like Downloads, and try again.",
    }
  // LEGACY: an installed copy from before `resources/installer.nsh` has an uninstaller the
  // new setup runs first, which stops by a plain path prefix, or every novadeck.exe by name
  // without PowerShell, either of which can close this copy. Told by the registry, not by
  // version: the new installer leaves `RunningCheck` beside the install record.
  if (await readLegacyUninstaller(appId, queryRegistry)) {
    const inside = legacyPrefixFolder(process.execPath, folders)
    if (inside !== undefined)
      return {
        kind: "failed",
        reason: `Novadeck can't install while this copy runs from a folder whose name starts with ${inside}. Move this copy somewhere else, like Downloads, and try again.`,
      }
    if (!(await legacyInstallerPowerShell()))
      return {
        kind: "failed",
        reason:
          "Novadeck can't install itself while it runs on this PC. Quit Novadeck, then run the installer from the Releases page.",
      }
  }
  const repository = await releaseRepository()
  const outcome = await prepareSetup({
    downloads: {
      latest: repository && releaseLatestUrl(repository),
      own: repository && releaseDownloadsUrl(repository, app.getVersion()),
    },
    version: app.getVersion(),
    text: fetchText,
    download: downloadSetup,
    remove: (file) => rm(file, { force: true }),
    progress: (percent) => progress({ phase: "downloading", percent }),
    log: warnings("install"),
  })
  if (outcome.kind === "failed") return outcome
  progress({ phase: "installing" })
  // Not given `--updated`, which marks an update made from the running app; this is a
  // fresh install, and `/S` alone starts nothing afterwards.
  const ran = await runSetup({
    file: outcome.setup,
    spawn,
    exists: existsSync,
    timeoutMs: setupWaitMs,
    log: warnings("install"),
  })
  const installed =
    ran === "failed"
      ? undefined
      : installedAtLeast(await installedCopies().catch(() => []), outcome.version)
  // A setup still running at the timeout holds its folder; the next try says so.
  if (ran !== "timeout") await rm(setupFolder(), { recursive: true, force: true }).catch(() => {})
  return setupResult(ran, installed)
}

// Reads the versions of installed AppImages with the environment they are started with.
const installedExtract = () =>
  extractWithProcess(installedEnvironment(process.env, appImageMounts()))

// The copies of the app installed on this machine, with their versions.
const installedCopies = () =>
  process.platform === "win32"
    ? findInstalledWindows({
        defaultFolder: defaultInstallFolder(),
        executable: basename(process.execPath),
        record: installRecord,
        exists: (path) =>
          access(path).then(
            () => true,
            () => false,
          ),
      })
    : process.platform === "darwin"
      ? findInstalledApps({
          folders: ["/Applications", join(homedir(), "Applications")],
          names: installedNames(),
          exists: (path) =>
            access(path).then(
              () => true,
              () => false,
            ),
          readFile: (path) => readFile(path, "utf8"),
        })
      : findInstalled({ env: process.env, home: homedir() }, installedExtract())

// Installs the AppImage that is running, over the installed copy `target` or at the
// installer's path.
const installAppImageOver = (
  target: string | undefined,
  progress: (step: InstallStep) => void,
): Promise<PlatformInstall> => {
  progress({ phase: "installing" })
  return installAppImage(
    process.env.APPIMAGE ?? "",
    installLayout({ env: process.env, home: homedir() }),
    installedExtract(),
    target,
  )
}

// The note a portable launch leaves when it redirects to the installed copy, and how long it holds.
const redirectWindowMs = 30_000
const redirect = redirectMarker(
  join(app.getPath("userData"), "redirected-at"),
  redirectWindowMs,
  {
    modified: (file) => statSync(file).mtimeMs,
    write: (file) => writeFileSync(file, ""),
    remove: (file) => rmSync(file, { force: true }),
  },
  Date.now,
  warnings("portable"),
)

// What the host logs of the runner's starts, ends and output.
const runnerEvents = (): RunnerEvents => {
  const runnerLog = logger.for("runner")
  const output = logRunnerOutput(runnerLog)
  return {
    spawned: (start) =>
      runnerLog.info("runner.spawn", "The runner was started.", { data: { run: start } }),
    ready: (start, ms) =>
      runnerLog.info("runner.ready", "The runner answered.", { data: { run: start, ms } }),
    exited: (start, code, expected) => {
      if (expected) {
        runnerLog.info("runner.exit", "The runner exited.", {
          data: { run: start, code, expected },
        })
        return
      }
      runnerLog.error("runner.exit", "The runner exited unexpectedly.", {
        data: { run: start, code, expected },
      })
      // Still said where it always was, as the system's journal keeps a desktop app's output.
      console.error(`Novadeck runner exited unexpectedly (code ${code})`)
    },
    outputEnded: (start, stream) => output.end(start, stream),
    output: (start, stream, line) => {
      output.line(start, stream, line)
      if (!app.isPackaged)
        (stream === "stderr" ? process.stderr : process.stdout).write(`${line}\n`)
    },
  }
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
  const portable = portableOf({ ...(await baseBuild()), signed: false })
  const known = await baseBuild()
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
  // An installed copy that starts answers a redirect: a later portable launch redirects again.
  if (!portable) redirect.clear()
  // An install interrupted on macOS may have left the only installed copy renamed aside,
  // and a half-made one; tidy before looking for installed copies.
  if (portable && process.platform === "darwin")
    await recoverBundles({ ...bundleMachine(), names: installedNames() }).catch(() => undefined)
  // A portable copy gives way to an installed copy of the same version or a newer one,
  // which may have upgraded the data this copy cannot open; nothing has started yet, so
  // there is nothing to shut down.
  if (
    await leaveForNewerInstalled({
      portable,
      version: app.getVersion(),
      find: installedCopies,
      start: startInstalledCopy,
      alert: alertNotStarted,
      recentRedirect: redirect.recent,
      markRedirect: redirect.mark,
      quit: () => exitApp(0),
      log: warnings("portable"),
    })
  )
    return
  // The installed copy has no use for a setup the portable copy left; the installer that
  // started this copy may still hold it for a moment, so this waits, and gives up quietly.
  if (process.platform === "win32" && app.isPackaged && !portable)
    setTimeout(
      () => void rm(setupFolder(), { recursive: true, force: true }).catch(() => {}),
      60_000,
    ).unref()
  channel = updateState.read().channel
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
  await settleWhatsNewLaunch()
  runner = startRunner({
    transcriptKey,
    entry: join(currentDirectory, "runner.js"),
    database: join(app.getPath("userData"), "workspace.sqlite"),
    relay: relayPath(),
    ...voice,
    ...murmur,
    softwareGraphics,
    log: (start) => JSON.stringify(logSetup(start)),
    events: runnerEvents(),
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
    create: (notice) => new Notification(notificationText(notice, process.platform)),
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
      void updatePage()
        .then((url) => {
          if (url) return shell.openExternal(url)
        })
        .catch((error: unknown) =>
          log.warn("update.page-failed", "The release page did not open.", { err: error }),
        )
    },
    allow: () => void allowUpdates(),
    channel: () => channel,
    setChannel: (next) => {
      if (next === channel) return
      channel = next
      updates?.setChannel(next)
      try {
        updateState.setChannel(next)
      } catch (error) {
        log.warn("update.channel-not-kept", "The update channel was not kept.", { err: error })
      }
    },
  })
  // The page learns what is new after an update, once.
  registerWhatsNewIpc(ipcMain, {
    window: (event) => appWindow(event)?.webContents,
    whatsNew: whatsNew.whatsNew,
    dismiss: whatsNew.dismiss,
  })
  // The page learns whether this is a portable copy and may install the app from it,
  // while this copy keeps running, and is told how the install goes.
  registerPortableIpc(ipcMain, {
    window: (event) => appWindow(event)?.webContents,
    log: warnings("portable"),
    installer: portableInstaller({
      portable,
      version: app.getVersion(),
      run,
      uncheckedAdvice:
        process.platform === "darwin"
          ? "Check the copy in your Applications folder, or reinstall Novadeck from the disk image."
          : process.platform === "win32"
            ? "Open the installed Novadeck from the Start menu, or uninstall it in Windows Settings and try again."
            : "Try again, or reinstall Novadeck with install.sh.",
      find: installedCopies,
      install: (target, progress) =>
        process.platform === "darwin"
          ? installMacBundle(target, progress)
          : process.platform === "win32"
            ? installWindowsSetup(progress)
            : installAppImageOver(target, progress),
      changed: (state) => {
        for (const page of appPages(BrowserWindow.getAllWindows())) {
          try {
            page.send(portableStateChannel, state)
          } catch (error) {
            log.warn("portable.send-failed", "The portable state was not sent to a window.", {
              err: error,
            })
          }
        }
      },
      stopping: () => stopping,
      log: warnings("portable"),
    }),
  })
  // The page learns what removing this copy would do, removes it, and quits afterwards.
  registerUninstallIpc(ipcMain, {
    window: (event) => appWindow(event)?.webContents,
    uninstaller: uninstaller({
      platform: process.platform,
      packaged: app.isPackaged,
      portable,
      env: process.env,
      home: homedir(),
      execPath: app.getPath("exe"),
      userData: app.getPath("userData"),
      defaultUserData: join(app.getPath("appData"), dataFolderName({ packaged: app.isPackaged })),
      uid: process.getuid?.(),
      realpath: realpathOrUndefined,
      exists: existsSync,
      linkTarget: (path) => readlink(path).catch(() => undefined),
      remove: (path, { recursive }) => rm(path, { recursive, force: true }),
      removeEmptyFolder: (path) => rmdir(path).catch(() => {}),
      trash: (path) => shell.trashItem(path),
      // pkexec shows the system's own password prompt and fails without one to show.
      privileged: (args) =>
        new Promise((resolve) =>
          execFile("pkexec", [...args], { timeout: 120_000 }, (error) => resolve(!error)),
        ),
      startUninstaller: (file) =>
        startDetached({
          file,
          cwd: dirname(file),
          spawn,
          exists: existsSync,
          releaseLock: () => {},
          reclaimLock: () => true,
          exit: () => {},
          log: warnings("uninstall"),
        }),
      removeAfterExit: (folders, uninstallerFile) =>
        startRemovalAfterExit({
          pid: process.pid,
          folders,
          setup: uninstallerFile,
          spawn,
          log: warnings("uninstall"),
        }),
      // Quitting as usual, less the install of a waiting update, which would put the app
      // back.
      shutdown: () => {
        stopping = true
        updates?.stop()
        if (updater) updater.autoInstallOnAppQuit = false
        macQuitInstall.autoInstallOnAppQuit = false
        return shutDown()
      },
      stopping: () => stopping,
      quit: () => app.quit(),
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
  // The app's page has a picture taken of one of its own page views, to show while it rests.
  ipcMain.handle(pagePictureChannel, (event, id: unknown) =>
    appWindow(event)
      ? picturePage(event.sender, id, (page) => webContents.fromId(page))
      : undefined,
  )
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

  if (!app.isPackaged) await waitFor(developmentOrigin)

  createWindow(server.origin)
  void startUpdates().catch((error: unknown) =>
    log.warn("update.start-failed", "Updates did not start.", { err: error }),
  )
}

app.setAppUserModelId(appId)

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
app.on("render-process-gone", (_event, contents, details) =>
  pageLog.error("ui.gone", "A page ended unexpectedly.", {
    data: { reason: details.reason, exitCode: details.exitCode, contents: contents.getType() },
  }),
)
const watchPage = (contents: WebContents): void => {
  contents.on("unresponsive", () =>
    pageLog.warn("ui.unresponsive", "A window's page stopped answering."),
  )
  contents.on("responsive", () => pageLog.info("ui.responsive", "A window's page answers again."))
  contents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
    if (mainFrame)
      pageLog.error("ui.load-failed", "A window's page did not load.", {
        data: { code, description, url },
      })
  })
  contents.on("preload-error", (_event, _path, error) =>
    pageLog.error("ui.preload-failed", "A window's preload failed.", { err: error }),
  )
}

// A window shown again: the one a second launch asked for.
const bringForward = (window: BrowserWindow): void => {
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

app.on("second-instance", () => {
  const [window] = BrowserWindow.getAllWindows()
  if (window) bringForward(window)
  // On macOS the app lives on with no window, so a second launch has none to show; one
  // that is quitting opens none.
  else if (server && !stopping) createWindow(server.origin)
  if (process.platform === "darwin") app.focus({ steal: true })
})

app.whenReady().then(() => {
  if (!primaryInstance) return
  transcriptKey = loadKey()
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
  lockPagesSession((partition) => session.fromPartition(partition), pagesPartition)
  const pages = session.fromPartition(pagesSession(pagesPartition))
  // A page signing in with a passkey it doesn't name, when more than one fits.
  pickPasskeys(pages, async ({ relyingPartyId, accounts, frame }) => {
    // A page view's window is its host's; a sign-in window's is its own.
    const contents = frame ? webContents.fromFrame(frame) : undefined
    const owner = contents?.hostWebContents ?? contents
    const window = owner ? BrowserWindow.fromWebContents(owner) : null
    const labels = passkeyLabels(accounts)
    const options = {
      type: "question" as const,
      message: `Which passkey do you sign in to ${relyingPartyId} with?`,
      buttons: [...labels, "Cancel"],
      cancelId: labels.length,
      noLink: true,
    }
    const { response } = await (window
      ? dialog.showMessageBox(window, options)
      : dialog.showMessageBox(options))
    return accounts[response]?.credentialId
  })
  // The app's page hears of the requests a page in its view sees fail, to tell the agent.
  const pageRequests = watchPageRequests(pages, (contentsId, failure) => {
    const host = webContents.fromId(contentsId)?.hostWebContents
    if (!host || host.isDestroyed()) return
    // A window closing or reloading meanwhile must not throw into the main process.
    try {
      host.send(pageRequestChannel, contentsId, failure)
    } catch (error) {
      log.warn("pages.request-send-failed", "A failed page request was not sent to its window.", {
        err: error,
      })
    }
  })
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "webview") {
      guardPage(contents, (url) => shell.openExternal(url), pagesPartition)
      const { id } = contents
      contents.once("destroyed", () => pageRequests.forget(id))
      // Its viewer keeps the page live while a sign-in window of it is open, as the window
      // closes with the page.
      countSignIns(contents, (count) => {
        // A view that went with its windows open is gone before they close: nothing to tell.
        if (contents.isDestroyed()) return
        try {
          const host = contents.hostWebContents
          if (!host || host.isDestroyed()) return
          host.send(pageSignInChannel, id, count)
        } catch (error) {
          log.warn("pages.sign-in-send-failed", "A sign-in window count was not sent.", {
            err: error,
          })
        }
      })
      // Its sign-in windows' failed requests are counted too, under their own ids.
      contents.on("did-create-window", (window) => {
        const popup = window.webContents.id
        window.webContents.once("destroyed", () => pageRequests.forget(popup))
      })
    }
    // A page's sign-in window (see `guardPage`) is a page's, not the app's.
    if (contents.getType() === "window" && contents.session !== pages) watchPage(contents)
  })

  void launch().catch((error: unknown) => {
    log.fatal("host.launch-failed", "The app could not start.", { err: error })
    console.error(error)
    exitApp(1)
  })

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (server && !stopping) createWindow(server.origin)
    }
  })
})

const declineUnorderlyInstall = installOnlyOnOrderlyQuit(
  () => updater,
  () => orderlyQuit,
)

app.on("before-quit", (event) => {
  // The quit already under way ends the app once the update is in place.
  if (macInstalling) return event.preventDefault()
  if (!stopping) log.info("app.quit", "The app is quitting.", { data: { orderly: orderlyQuit } })
  // No new download starts on the way out.
  updates?.stop()
  if (process.platform === "linux") declineUnorderlyInstall()
  if ((!server && !runner) || stopping) return

  event.preventDefault()
  stopping = true
  void shutDown()
    .then(installMacUpdateOnQuit)
    .finally(() => app.quit())
})

app.on("window-all-closed", () => {
  orderlyQuit = true
  if (process.platform !== "darwin") app.quit()
})
