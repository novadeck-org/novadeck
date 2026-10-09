import { dirname } from "node:path"
import { isAbsolute, relative } from "node:path/posix"

import { updateVersionPattern } from "@novadeck/protocol/bridge"
import type { IpcMainEvent } from "electron"

import { installUpdateChannel, updateReadyChannel, updateRequestChannel } from "../bridge.js"

/** How long after launch the first check waits, so it never competes with startup. */
export const firstCheckMs = 10_000
/** How long between checks after that: a few hours, as people keep the app open for days. */
export const checkIntervalMs = 4 * 60 * 60 * 1000

/** What decides whether a build updates itself. */
export type UpdateBuild = {
  readonly packaged: boolean
  readonly version: string
  readonly platform: NodeJS.Platform
  /** The running executable, `process.execPath`. */
  readonly execPath: string
  readonly env: Readonly<Record<string, string | undefined>>
}

// Whether `file` lies inside the folder `directory`, both absolute POSIX paths.
const isInside = (directory: string, file: string): boolean => {
  const path = relative(directory, file)
  return path !== "" && path !== ".." && !path.startsWith("../") && !isAbsolute(path)
}

/**
 * Whether a build updates itself: `yes`, `no`, or `signed` when it does only if its app
 * bundle is Developer ID signed, as Squirrel.Mac refuses to install into any other.
 * Local and pull request builds carry version 0.0.0 and never update; neither does a
 * development run, nor does a launch with `NOVADECK_UPDATES=off`, as the smoke tests give,
 * so none of them reaches the network. Of the Linux builds only the AppImage can replace
 * itself, the deb and rpm belong to the package manager. A shell started inside an
 * AppImage inherits `APPIMAGE`, so a deb launched from there would pass for one; the
 * running executable must lie inside `APPDIR`, the folder an AppImage mounts itself on.
 * Of the Windows builds the installed one can, the portable executable has nowhere to
 * install to.
 */
export const updateMode = ({
  packaged,
  version,
  platform,
  execPath,
  env,
}: UpdateBuild): "yes" | "no" | "signed" => {
  if (!packaged || version === "0.0.0" || env.NOVADECK_UPDATES === "off") return "no"
  if (platform === "darwin") return "signed"
  if (platform === "linux")
    return env.APPIMAGE && env.APPDIR && isInside(env.APPDIR, execPath) ? "yes" : "no"
  if (platform === "win32") return env.PORTABLE_EXECUTABLE_DIR ? "no" : "yes"
  return "no"
}

/** The app bundle a macOS executable, `novadeck.app/Contents/MacOS/novadeck`, runs from. */
export const bundleOf = (executable: string): string => dirname(dirname(dirname(executable)))

/**
 * Whether `codesign --display --verbose=2` output names a Developer ID signature. An
 * unsigned or ad-hoc signed bundle names none, and Squirrel.Mac would refuse its update
 * after the whole archive was downloaded.
 */
export const developerIdSigned = (output: string): boolean =>
  /^Authority=Developer ID Application: /m.test(output)

/** The version of an update when it is one the page may be told of, or undefined. */
export const updateVersionOf = (value: unknown): string | undefined =>
  typeof value === "string" && updateVersionPattern.test(value) ? value : undefined

// The part of a window that telling it of an update uses.
type Page = { send(channel: string, version: string): void }

/**
 * Remembers the version of the update that was downloaded and tells every page of it:
 * `downloaded` those open now, `request` a page that started listening later, such as
 * after a reload or in a new window. `pages` lists the windows showing the app's own UI.
 */
export const trackUpdate = <P extends Page>(pages: () => readonly P[]) => {
  let waiting: string | undefined
  return {
    version: (): string | undefined => waiting,
    downloaded: (value: unknown): void => {
      const version = updateVersionOf(value)
      // A later check that finds the same download again has nothing new to tell.
      if (version === undefined || version === waiting) return
      waiting = version
      for (const page of pages()) page.send(updateReadyChannel, version)
    },
    request: (page: P): void => {
      if (waiting !== undefined) page.send(updateReadyChannel, waiting)
    },
  }
}

type UpdateIpc = {
  on(channel: string, listener: (event: IpcMainEvent) => void): unknown
}

/**
 * Answers the app's own pages: a request for the update waiting, and the request to
 * install it. `window` names the window of a request from the main frame of the app's
 * own page, or undefined for any other sender, which is ignored.
 */
export const registerUpdateIpc = <Window>(
  ipc: UpdateIpc,
  {
    window,
    request,
    install,
  }: {
    readonly window: (event: IpcMainEvent) => Window | undefined
    readonly request: (window: Window) => void
    readonly install: () => void
  },
): void => {
  ipc.on(updateRequestChannel, (event) => {
    const target = window(event)
    if (target !== undefined) request(target)
  })
  ipc.on(installUpdateChannel, (event) => {
    if (window(event) !== undefined) install()
  })
}

/**
 * How long a restart waits for the updater to end the app before quitting it. Installing
 * can fail without a word: electron-updater's `quitAndInstall` logs a failed Linux or
 * Windows install and returns, and its macOS one waits for Squirrel.Mac, which may never
 * have the update. Squirrel stages from a local copy, so macOS gets longer.
 */
export const installFallbackMs = (platform: NodeJS.Platform): number =>
  platform === "darwin" ? 30_000 : 10_000

/**
 * Restarts into the downloaded update after the same shutdown quitting runs. Does
 * nothing while no update is downloaded or a shutdown already started, which makes a
 * second request harmless. The shells are gone by then, so the app must not go on
 * running: should installing throw, or still not have ended the app after `fallbackMs`,
 * it quits. That quit installs on the way out if the updater still can, as any quit does.
 */
export const installUpdate = ({
  downloaded,
  stopping,
  stop,
  shutdown,
  install,
  quit,
  fallbackMs,
}: {
  readonly downloaded: () => boolean
  readonly stopping: () => boolean
  readonly stop: () => void
  readonly shutdown: () => Promise<void>
  readonly install: () => void
  readonly quit: () => void
  readonly fallbackMs: number
}): void => {
  if (!downloaded() || stopping()) return
  stop()
  void shutdown()
    .then(install)
    .then(() => void setTimeout(quit, fallbackMs))
    .catch(quit)
}

/**
 * A quit that leaves an update waiting uninstalled: for the system ending the session,
 * which may kill a silent installer or an AppImage swap halfway. Ordinary quits install.
 * On macOS Squirrel.Mac installs a staged update on any exit, which this cannot stop; it
 * swaps the bundle whole, so an interrupted install leaves the old app.
 */
export const quitWithoutInstalling =
  (updater: () => Pick<Updater, "autoInstallOnAppQuit"> | undefined, quit: () => void) =>
  (): void => {
    const current = updater()
    if (current) current.autoInstallOnAppQuit = false
    quit()
  }

/** What checking for updates uses of electron-updater's `autoUpdater`. */
export type Updater = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  logger: {
    info(message?: unknown): void
    warn(message?: unknown): void
    error(message?: unknown): void
  } | null
  on(event: "update-downloaded", listener: (info: { readonly version: string }) => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
}

/** The part of Electron's native `autoUpdater` that learning of a staged update uses. */
export type NativeUpdater = {
  once(event: "update-downloaded", listener: () => void): unknown
}

/**
 * Checks for updates shortly after launch and every few hours, downloading what it finds
 * and installing it when the app next quits; `downloaded` hears of the download. Every
 * release is still a prerelease, which the updater skips unless told otherwise. A check
 * that fails, offline or rate limited, is logged and the next one tries again.
 *
 * The schedule ends with the first download: a newer release found later empties the
 * folder the downloaded file waits in while the updater still names that file, and quitting
 * then would install nothing, or delete the running AppImage. The next launch checks again.
 *
 * On macOS, pass Electron's `native` updater: electron-updater reports a download before
 * Squirrel.Mac has staged it, and restarting before then waits on Squirrel indefinitely.
 * `downloaded` hears of the update, under electron-updater's version, once Squirrel has it.
 * Returns a function that cancels the schedule.
 */
export const checkForUpdates = (
  updater: Updater,
  {
    native,
    downloaded,
    log,
  }: {
    readonly native?: NativeUpdater | undefined
    readonly downloaded: (version: string) => void
    readonly log: (message: string, error: unknown) => void
  },
): (() => void) => {
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.allowPrerelease = true
  // Quiet: failures are reported through `log`, and routine progress is not worth a line.
  updater.logger = { info: () => {}, warn: () => {}, error: () => {} }
  updater.on("error", (error) => log("The update check failed.", error))
  updater.on("update-downloaded", (info) => {
    cancel()
    // A check still in flight finds no more to download.
    updater.autoDownload = false
    // electron-updater reports the download just before it hands the file to Squirrel,
    // so listening now is in time for the native event that follows.
    if (native) native.once("update-downloaded", () => downloaded(info.version))
    else downloaded(info.version)
  })

  const check = (): void => {
    // The updater reports a failed check through its error event, which logs it.
    updater.checkForUpdates().catch(() => {})
  }
  const first = setTimeout(check, firstCheckMs)
  const every = setInterval(check, checkIntervalMs)
  const cancel = (): void => {
    clearTimeout(first)
    clearInterval(every)
  }
  return cancel
}
