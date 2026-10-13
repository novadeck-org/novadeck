import { dirname } from "node:path"
import { isAbsolute, relative } from "node:path/posix"

import {
  updateChannels,
  updateVersionPattern,
  type UpdateChannel,
  type UpdateOffer,
  type UpdateOfferKind,
} from "@novadeck/protocol/bridge"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import {
  installUpdateChannel,
  openUpdatePageChannel,
  setUpdateChannelChannel,
  updateChannelChannel,
  updateOfferChannel,
  updateRequestChannel,
} from "../bridge.js"
import { updateNotesLines } from "./update-notes.js"

/** How long after launch the first check waits, so it never competes with startup. */
export const firstCheckMs = 10_000
/** How long between checks after that: a few hours, as people keep the app open for days. */
export const checkIntervalMs = 4 * 60 * 60 * 1000
/** How long after switching channels the check on the new one waits, so a few clicks make one. */
export const switchCheckMs = 2_000
/** How long after a download failed the check that tries it again, once, waits. */
export const retryCheckMs = 5 * 60 * 1000

/** What decides whether and how a build updates itself. */
export type UpdateBuild = {
  readonly packaged: boolean
  readonly version: string
  readonly platform: NodeJS.Platform
  /** The running executable, `process.execPath`. */
  readonly execPath: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** Whether the macOS app bundle is Developer ID signed; see `developerIdSigned`. */
  readonly signed: boolean
  /** Whether the macOS app runs from an Applications folder; Electron's `isInApplicationsFolder`. */
  readonly inApplications: boolean
  /** Whether the folder holding the AppImage file can be written to. */
  readonly appImageWritable: boolean
  /** Whether the AppImage file is at an installed place; see `isInstalledImage`. */
  readonly appImageInstalled: boolean
  /** Whether the Windows build was installed by the NSIS installer; see `installedByInstaller`. */
  readonly windowsInstalled: boolean
}

/** The kind of build, which decides the electron-updater class that serves it. */
export type UpdaterKind = "nsis" | "mac" | "appimage"

/**
 * How a build handles updates: `install` downloads them and installs them, `tell` only
 * learns that a newer release exists and offers its page.
 */
export type UpdateMode = "install" | "tell"

/**
 * How a build updates. A `portable` build runs from wherever it was put and is never
 * installed: it does not install updates itself, though it still looks for them, so the
 * page can offer to install the app that does.
 */
export type UpdatePlan = {
  readonly kind: UpdaterKind
  readonly mode: UpdateMode
  readonly portable: boolean
}

// Whether `file` lies inside the folder `directory`, both absolute POSIX paths.
const isInside = (directory: string, file: string): boolean => {
  const path = relative(directory, file)
  return path !== "" && path !== ".." && !path.startsWith("../") && !isAbsolute(path)
}

/**
 * Which kind of build this is, or undefined for one electron-updater has no way to serve.
 * An AppImage is the one whose `APPIMAGE` is set and whose running executable lies inside
 * `APPDIR`, the folder an AppImage mounts itself on; a shell started inside an AppImage
 * inherits both variables, so another build launched from there is told apart by its
 * executable. The AppImage is the only Linux build released, so any other, such as one
 * built from source or a distribution's own package, has no updater and leaves updating
 * to whoever installed it.
 */
const updaterKind = ({ platform, execPath, env }: UpdateBuild): UpdaterKind | undefined => {
  if (platform === "win32") return "nsis"
  if (platform === "darwin") return "mac"
  if (platform !== "linux") return undefined
  if (env.APPIMAGE && env.APPDIR && isInside(env.APPDIR, execPath)) return "appimage"
  return undefined
}

// Whether a build looks for updates at all, before asking which kind it is.
const looksForUpdates = ({ packaged, version, env }: UpdateBuild): boolean =>
  packaged && version !== "0.0.0" && env.NOVADECK_UPDATES !== "off"

/**
 * Whether a build is portable: one that runs from wherever it was put, and is meant to
 * lead the person to the installed app instead of updating itself. On Linux that is an
 * AppImage anywhere but the places the installer puts it. On macOS it is the app anywhere
 * but an Applications folder, such as Downloads, a translocated copy or the mounted disk
 * image, whether signed or not. On Windows it is the unpacked ZIP, which nothing marks
 * but the installer's absence (see `installedByInstaller`). A build that looks for no
 * updates is never portable, as a portable offers to install the current release.
 */
export const portableOf = (build: UpdateBuild): boolean => {
  if (!looksForUpdates(build)) return false
  switch (updaterKind(build)) {
    case "appimage":
      return !build.appImageInstalled
    case "mac":
      return !build.inApplications
    case "nsis":
      return !build.windowsInstalled
    default:
      return false
  }
}

/**
 * How a build updates, or undefined when it does not look for updates at all. Local and
 * pull request builds carry version 0.0.0 and never look; neither does a development run,
 * nor does a launch with `NOVADECK_UPDATES=off`, as the smoke tests give, so none of them
 * reaches the network. Nor does a Linux build that is not an AppImage, as none is released.
 * Every other build either installs updates itself or tells of them:
 *
 * - The Windows installer installs. A portable one, the unpacked ZIP, only tells: an NSIS
 *   updater would install a separate copy on quit.
 * - macOS installs when the app bundle is Developer ID signed, as Squirrel.Mac refuses
 *   to install into any other, and tells otherwise. A portable one, outside Applications,
 *   only tells.
 * - An installed AppImage, one at a place the installer puts it, installs by replacing
 *   its own file, which takes write access to the folder it sits in, and tells otherwise.
 * - A portable AppImage, one anywhere else, only tells; see `portableOf`.
 *
 * A release whose install failed, say because the installer failed, is told of
 * rather than installed; see `checkForUpdates`.
 */
export const updatePlan = (build: UpdateBuild): UpdatePlan | undefined => {
  if (!looksForUpdates(build)) return undefined
  const kind = updaterKind(build)
  if (kind === undefined) return undefined
  const portable = portableOf(build)
  const installable =
    kind === "mac" ? build.signed : kind === "appimage" ? build.appImageWritable : true
  return {
    kind,
    mode: installable && !portable ? "install" : "tell",
    portable,
  }
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
type Page = { send(channel: string, offer: UpdateOffer): void }

/**
 * Remembers the last offer and tells every page of it: `offer` those open now, `request`
 * a page that started listening later, such as after a reload or in a new window. A
 * report of what the pages already know is dropped, and that includes the `percent` of a
 * `downloading` offer, so each whole percent a download reaches is told once; any other
 * replaces the last, a newer version and a `ready` update the host then could not install
 * alike. `pages` lists the windows showing the app's own UI. Only a `downloading` offer
 * carries a `percent`. A portable copy passes `outdatedSince`, which gives when this copy
 * first learned a newer release exists; it is asked only for an offer that is new.
 */
export const trackOffer = <P extends Page>(pages: () => readonly P[]) => {
  let last: UpdateOffer | undefined
  return {
    current: (): UpdateOffer | undefined => last,
    offer: (
      kind: UpdateOfferKind,
      value: unknown,
      notes: readonly string[],
      {
        percent,
        outdatedSince,
      }: {
        readonly percent?: number | undefined
        readonly outdatedSince?: (() => string | undefined) | undefined
      } = {},
    ): void => {
      const version = updateVersionOf(value)
      const progress = kind === "downloading" ? percent : undefined
      if (
        version === undefined ||
        (last?.kind === kind && last.version === version && last.percent === progress)
      )
        return
      const since = outdatedSince?.()
      last = {
        kind,
        version,
        notes,
        ...(progress === undefined ? {} : { percent: progress }),
        ...(since === undefined ? {} : { outdatedSince: since }),
      }
      for (const page of pages()) page.send(updateOfferChannel, last)
    },
    request: (page: P): void => {
      if (last !== undefined) page.send(updateOfferChannel, last)
    },
  }
}

// What a page that is not the app's own is told of the channel.
const defaultChannel: UpdateChannel = "stable"

type UpdateIpc = {
  on(channel: string, listener: (event: IpcMainEvent, ...values: unknown[]) => void): unknown
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown,
  ): unknown
}

/**
 * Answers the app's own pages: a request for the last offer, the requests to install it
 * or open its release page, and those about the update channel. `window` names the
 * window of a request from the main frame of the app's own page, or undefined for any
 * other sender, which is ignored; the page is then told the default channel, which is
 * all it may learn. The page names no version or address, and a channel it names counts
 * only when it is a known one.
 */
export const registerUpdateIpc = <Window>(
  ipc: UpdateIpc,
  {
    window,
    request,
    install,
    openPage,
    channel,
    setChannel,
  }: {
    readonly window: (event: IpcMainEvent | IpcMainInvokeEvent) => Window | undefined
    readonly request: (window: Window) => void
    readonly install: () => void
    readonly openPage: () => void
    readonly channel: () => UpdateChannel
    readonly setChannel: (channel: UpdateChannel) => void
  },
): void => {
  ipc.on(updateRequestChannel, (event) => {
    const target = window(event)
    if (target !== undefined) request(target)
  })
  ipc.on(installUpdateChannel, (event) => {
    if (window(event) !== undefined) install()
  })
  ipc.on(openUpdatePageChannel, (event) => {
    if (window(event) !== undefined) openPage()
  })
  ipc.handle(updateChannelChannel, (event) =>
    window(event) === undefined ? defaultChannel : channel(),
  )
  ipc.on(setUpdateChannelChannel, (event, value: unknown) => {
    const next = updateChannels.find((known) => known === value)
    if (window(event) !== undefined && next !== undefined) setChannel(next)
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
 * second request harmless. `settled` (see `checkForUpdates`) is waited for first, and
 * nothing is restarted unless it holds: a newer release still downloading in place of the
 * update is shown to the page instead, to restart into once it is in. The shells are gone
 * once it goes ahead, so
 * the app must not go on running: should installing throw, or still not have ended the
 * app after `fallbackMs`, it quits. That quit installs on the way out if the updater
 * still can, as any quit does.
 *
 * The wait for the updater to end the app starts only once `install` returns.
 */
export const installUpdate = ({
  downloaded,
  settled,
  stopping,
  stop,
  shutdown,
  install,
  quit,
  fallbackMs,
}: {
  readonly downloaded: () => boolean
  readonly settled: () => Promise<boolean>
  readonly stopping: () => boolean
  readonly stop: () => void
  readonly shutdown: () => Promise<void>
  readonly install: () => void
  readonly quit: () => void
  readonly fallbackMs: number
}): void => {
  if (!downloaded() || stopping()) return
  void settled().then((ready) => {
    // A request made while the same download was awaited may have gone ahead first.
    if (!ready || stopping()) return
    stop()
    void shutdown()
      .then(install)
      .then(() => void setTimeout(quit, fallbackMs))
      .catch(quit)
  })
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

/**
 * Switches installing on quit off for a quit that is not an orderly one, on Linux, where
 * Electron turns SIGTERM, SIGINT and SIGHUP into an ordinary quit with exit code 0, which
 * electron-updater installs on. A desktop logout or `kill` would then swap the AppImage in
 * the middle of ending the session, and the system may kill the swap halfway. The
 * orderly quits are closing the last window and restarting into the update, and both
 * are marked before the quit begins; any other, a signal or the menu's Quit, finds the
 * mark missing. Switching off is one way: nothing switches it on again.
 */
export const installOnlyOnOrderlyQuit =
  (updater: () => Pick<Updater, "autoInstallOnAppQuit"> | undefined, orderly: () => boolean) =>
  (): void => {
    const current = updater()
    if (current && !orderly()) current.autoInstallOnAppQuit = false
  }

/** What checking for updates uses of electron-updater's updaters. */
export type Updater = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  logger: {
    info(message?: unknown): void
    warn(message?: unknown): void
    error(message?: unknown): void
  } | null
  on(
    event: "update-available" | "update-downloaded",
    listener: (info: {
      readonly version: string
      readonly releaseName?: unknown
      readonly releaseNotes?: unknown
    }) => void,
  ): unknown
  on(
    event: "download-progress",
    listener: (progress: { readonly percent: number }) => void,
  ): unknown
  on(event: "update-not-available", listener: () => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  /** The install that quitting runs, and the one a restart runs; see `checkForUpdates`. */
  install?: (isSilent?: boolean, isForceRunAfter?: boolean) => boolean
  quitAndInstall?: (isSilent?: boolean, isForceRunAfter?: boolean) => void
}

/** The part of Electron's native `autoUpdater` that learning of a staged update uses. */
export type NativeUpdater = {
  once(event: "update-downloaded", listener: () => void): unknown
}

/**
 * Checks for updates shortly after launch and every few hours; a check that fails,
 * offline, rate limited, or on a channel with no release yet, is logged and the next one
 * tries again. `channel` decides which releases count: `stable` is GitHub's latest
 * release that is not a prerelease, `early` every release. Updating never downgrades.
 *
 * In `install` mode it downloads what it finds and installs it when the app next quits.
 * `offer` is told the update is `downloading` at each whole percent electron-updater
 * reports, from the first, then `ready` once downloaded. A download already on disk from
 * an earlier launch reports none, and is `ready` at once. A release whose download fails
 * is tried again, once in a run, by a check `retryCheckMs` later; after that the schedule
 * tries it. Meanwhile it is offered as `available`, to be
 * installed from the release page, once its progress or an update it replaces was
 * offered; one that failed before either goes untold, as a failed check does. The one
 * exception is the release `failedVersion`
 * names, the version an earlier install failed on: it is only told of, as `available`,
 * and not downloaded again, so a failing install does not come back at every launch. A
 * newer release installs as usual.
 *
 * One download is tracked at a time, whether the first or one in place of an update
 * already downloaded. While it is under way a release found is left to the next check, and
 * only its progress is offered. The schedule goes on once an update has downloaded, and a
 * newer release it finds replaces that update, so one restart lands on the latest
 * release. No release file carries a version in its name, so electron-updater downloads
 * the newer one beside the waiting file and renames it over that file once complete;
 * quitting meanwhile installs the waiting update on Windows and Linux. The offer turns
 * from `ready` to `downloading` the newer release as its progress comes in, so the page
 * shows it and no restart until it is in. Should it fail, the waiting file is likely gone
 * with it, as electron-updater clears its download folder then: the newer release is
 * offered as `available` until the retry downloads it. On macOS the schedule ends once an update has downloaded
 * instead, as whether Squirrel.Mac stages an update over one it has staged is untried;
 * the next launch checks again.
 *
 * An error raised while installing fails the install: installing on quit is switched
 * off, so the same failing install is not tried at every quit, `installFailed` hears of
 * the version, and `offer` is told the update is only `available`. Installing is when
 * the updater's `install` (quitting) or `quitAndInstall` (restarting) has been called,
 * which this wraps to know, and on macOS also while Squirrel stages the download; any
 * other error, such as a check still in flight failing offline, is only logged. The
 * notes of an offer are the release's, and none unless the update information names
 * that release.
 *
 * In `tell` mode it downloads and installs nothing, and tells `offer` each release newer
 * than this build is `available`, with its notes; the schedule goes on, so a newer
 * release replaces the offer.
 *
 * On macOS, pass Electron's `native` updater: electron-updater reports a download before
 * Squirrel.Mac has staged it, and restarting before then waits on Squirrel indefinitely.
 * The update stays `downloading`, at the last percent reported, until Squirrel has it,
 * and is `ready` then.
 *
 * `setChannel` follows another channel from the next check, and makes one soon, unless the
 * schedule has ended. `stop` ends the schedule, after which no new download starts; one
 * under way goes on. Quitting and restarting stop it first. `settled` gives whether an
 * update is downloaded and waits to install: once a download electron-updater has
 * reported in is done, and false while a newer release still downloads in place of the
 * update, which it then offers as `downloading`, so a restart asked for before its
 * progress came in shows it instead of going ahead later.
 */
export const checkForUpdates = (
  updater: Updater,
  {
    mode,
    channel,
    failedVersion,
    native,
    offer,
    upToDate,
    installFailed,
    log,
  }: {
    readonly mode: UpdateMode
    readonly channel: UpdateChannel
    /** The version installing failed on in an earlier launch, if it did. */
    readonly failedVersion?: string | undefined
    readonly native?: NativeUpdater | undefined
    /** `percent` is given for `downloading` only. */
    readonly offer: (
      kind: UpdateOfferKind,
      version: string,
      notes: readonly string[],
      percent?: number,
    ) => void
    /** Told whenever a check finds no newer release. */
    readonly upToDate?: (() => void) | undefined
    readonly installFailed: (version: string) => void
    readonly log: (message: string, error: unknown) => void
  },
): {
  readonly setChannel: (channel: UpdateChannel) => void
  readonly stop: () => void
  readonly settled: () => Promise<boolean>
} => {
  // Downloads are asked for, to leave out the release that failed to install.
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = mode === "install"
  updater.allowPrerelease = channel === "early"
  // Quiet: failures are reported through `log`, and routine progress is not worth a line.
  updater.logger = { info: () => {}, warn: () => {}, error: () => {} }

  let downloaded: { readonly version: string; readonly notes: readonly string[] } | undefined
  // The download under way, the first or a newer release's in place of `downloaded`, with
  // the whole percent last offered for it (-1 before any) and whether it came through.
  let loading:
    | {
        readonly version: string
        readonly notes: readonly string[]
        percent: number
        readonly done: Promise<boolean>
      }
    | undefined
  // Once an install has begun the app is on its way out, so the mark never goes back.
  let installing = false
  let staging = false
  let failed = false
  for (const method of ["install", "quitAndInstall"] as const) {
    const original: unknown = updater[method]
    if (typeof original !== "function") continue
    Object.assign(updater, {
      [method]: (...args: unknown[]): unknown => {
        installing = true
        return Reflect.apply(original, updater, args)
      },
    })
  }
  updater.on("error", (error) => {
    // MacUpdater reports a native error twice; the first is the failure, and the second
    // adds nothing to log or mark.
    if (failed) return
    if (downloaded === undefined || !(installing || staging))
      return log("The update check failed.", error)
    log("Installing the update failed.", error)
    failed = true
    staging = false
    updater.autoInstallOnAppQuit = false
    installFailed(downloaded.version)
    offer("available", downloaded.version, downloaded.notes)
  })
  updater.on("update-not-available", () => upToDate?.())
  updater.on("update-available", (info) => {
    if (mode === "tell") return offer("available", info.version, updateNotesLines(info))
    // A release found while a download is under way waits for the next check.
    if (ended || loading !== undefined || info.version === downloaded?.version) return
    if (info.version === failedVersion) {
      // A ready update stays ready rather than give way to the release that failed.
      if (downloaded === undefined) offer("available", info.version, updateNotesLines(info))
      return
    }
    const { version } = info
    const notes = updateNotesLines(info)
    // A failed download is reported through the error event, which logs it.
    const current = {
      version,
      notes,
      percent: -1,
      done: updater.downloadUpdate().then(
        () => true,
        () => {
          // Failing after it was reported in, as when copying its blockmap fails, leaves
          // the download where it is; a failed staging on macOS has been told of already.
          if (downloaded?.version === version) return !failed
          // The waiting file, if any, is likely gone with the failed download, so the
          // page is told, unless it has heard of neither.
          if (current.percent >= 0 || downloaded !== undefined) offer("available", version, notes)
          downloaded = undefined
          if (!ended && !retried.has(version)) {
            retried.add(version)
            clearTimeout(retry)
            retry = setTimeout(check, retryCheckMs)
          }
          return false
        },
      ),
    }
    loading = current
    void current.done.then(() => {
      if (loading === current) loading = undefined
    })
  })
  updater.on("download-progress", ({ percent }) => {
    // Progress of a download this module did not start, or one already in, is not offered.
    if (loading === undefined || downloaded?.version === loading.version) return
    const whole = Math.min(100, Math.max(0, Math.floor(percent)))
    if (whole === loading.percent) return
    loading.percent = whole
    offer("downloading", loading.version, loading.notes, whole)
  })
  updater.on("update-downloaded", (info) => {
    // Squirrel.Mac has the download staged, or soon will, and keeps it.
    if (native) stop()
    const notes = updateNotesLines(info)
    downloaded = { version: info.version, notes }
    const ready = (): void => {
      staging = false
      offer("ready", info.version, notes)
    }
    // electron-updater reports the download just before it hands the file to Squirrel,
    // so listening now is in time for the native event that follows.
    if (native) {
      staging = true
      native.once("update-downloaded", ready)
    } else ready()
  })

  const check = (): void => {
    // The updater reports a failed check through its error event, which logs it.
    updater.checkForUpdates().catch(() => {})
  }
  let ended = false
  let first = setTimeout(check, firstCheckMs)
  const every = setInterval(check, checkIntervalMs)
  // The check that tries a failed download again, and the releases it has been for.
  let retry: ReturnType<typeof setTimeout> | undefined
  const retried = new Set<string>()
  const stop = (): void => {
    ended = true
    clearTimeout(first)
    clearTimeout(retry)
    clearInterval(every)
  }
  return {
    setChannel: (next) => {
      updater.allowPrerelease = next === "early"
      if (ended) return
      clearTimeout(first)
      first = setTimeout(check, switchCheckMs)
    },
    stop,
    settled: () => {
      if (loading === undefined) return Promise.resolve(downloaded !== undefined)
      if (downloaded?.version === loading.version) return loading.done
      // A newer release is still coming in: the page is shown it rather than restarted.
      loading.percent = Math.max(0, loading.percent)
      offer("downloading", loading.version, loading.notes, loading.percent)
      return Promise.resolve(false)
    },
  }
}
