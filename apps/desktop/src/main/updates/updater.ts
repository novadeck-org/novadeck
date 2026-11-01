import type { OutgoingHttpHeaders } from "node:http"
import { isAbsolute, relative } from "node:path/posix"

import {
  parseUpdateOffer,
  updateChannels,
  type UpdateChannel,
  type UpdateOffer,
} from "@novadeck/protocol/bridge"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import {
  allowUpdatesChannel,
  openUpdatePageChannel,
  setUpdateChannelChannel,
  updateChannelChannel,
  updateOfferChannel,
  updateRequestChannel,
} from "../../bridge.js"
import { releaseDownloadsUrl, type ReleaseRepository } from "../releases/repository.js"
import { localOrigin, novadeckSite } from "../releases/site.js"
import { isNewerVersion } from "../releases/versions.js"

/** How long after launch the first check waits, so it never competes with startup. */
export const firstCheckMs = 10_000
/** How long between checks after that: an hour, as people keep the app open for days. Each
    check is counted on novadeck.dev, so an hour's checks are the copies open in it. */
export const checkIntervalMs = 60 * 60 * 1000
/** How long after switching channels the check on the new one waits, so a few clicks make one. */
export const switchCheckMs = 2_000
/** How long after a download failed the check that tries it again, once, waits. */
export const retryCheckMs = 5 * 60 * 1000

/**
 * How long the website's `experimental` answer is trusted, as the website itself counts it: the
 * app holds a release against an older answer from the website for this long.
 */
export const experimentalTrustMs = 6 * 60 * 60 * 1000

/** Why a check runs: the launch's, the schedule's, a channel switch's or a failed download's retry. */
export type CheckReason = "launch" | "interval" | "switch" | "retry"

/**
 * What the app adds to a check to say what copy makes it, so the website can count active
 * copies. It is the least that does: the app reads nothing else off the computer to send,
 * as that would need the person's consent. (The request carries more by itself: see
 * docs/auto-update.md.)
 */
export type CheckFacts = {
  readonly version: string
  readonly build: "installed" | "portable"
}

/** Where updates are looked for through novadeck.dev, and what a check says there. */
export type UpdateFeed = {
  /** The GitHub repository a check falls back to when novadeck.dev fails. */
  readonly repository: ReleaseRepository
  readonly facts: CheckFacts
  /** Another site to check, as `NOVADECK_UPDATE_URL` gives for testing; see `feedUrl`. */
  readonly site?: string | undefined
}

/**
 * The address, ending in "/", whose `latest*.yml` the channel's checks read: the website
 * counts each check and answers with GitHub's file, its downloads pinned to GitHub at that
 * release (docs/auto-update.md). `site` replaces the website's address for testing, and
 * only when it is an address on this computer (localhost, 127.0.0.1 or [::1], over http or
 * https); anything else is ignored.
 */
export const feedUrl = (channel: UpdateChannel, site?: string): string => {
  const origin = (site !== undefined && localOrigin(site)) || novadeckSite
  return `${origin}/update/${channel}/`
}

/**
 * Whether every file an update names is a GitHub release download of the repository: an
 * address under `https://github.com/<owner>/<repo>/releases/download/`, once relative
 * ones are resolved against where the answer came from (`base`). The website rewrites the
 * feed's addresses to GitHub's and the hashes come from the same file, so this is what stops
 * the website alone from shipping code: Linux and Windows check nothing else of a download.
 * `site` is the replacement for the website `NOVADECK_UPDATE_URL` gives for testing; files on
 * that computer's own address are let through when the answer came from it. An answer that
 * names no file is refused.
 */
export const filesFromGitHub = (
  info: { readonly files?: unknown },
  repository: ReleaseRepository,
  base: string,
  site?: string,
): boolean => {
  const { files } = info
  if (!Array.isArray(files) || files.length === 0) return false
  const prefix = `https://github.com/${repository.owner}/${repository.repo}/releases/download/`
  const local = site === undefined ? undefined : localOrigin(site)
  return files.every((file: unknown) => {
    const raw = (file as { readonly url?: unknown } | null)?.url
    if (typeof raw !== "string") return false
    try {
      const url = new URL(raw, base)
      if (url.username !== "" || url.password !== "") return false
      if (url.href.startsWith(prefix)) return true
      return local !== undefined && base.startsWith(local) && url.origin === local
    } catch {
      return false
    }
  })
}

// A header value only when it is short printable ASCII, so nothing odd reaches the wire.
const plain = (value: string): string | undefined =>
  /^[\x20-\x7e]{1,64}$/.test(value) ? value : undefined

/**
 * The headers the app adds to a check through novadeck.dev: why it runs and the copy's
 * version and build, and nothing that tells one copy from another. electron-updater's
 * per-install `x-user-staging-id` is sent nowhere, as its patch keeps it off every check
 * (apps/desktop/patches). A value that can't be known is left out.
 */
export const checkHeaders = (reason: CheckReason, facts: CheckFacts): Record<string, string> => {
  const entries: [string, string | undefined][] = [
    ["x-novadeck-check", reason],
    ["x-novadeck-version", plain(facts.version)],
    ["x-novadeck-build", facts.build],
  ]
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => !!entry[1]))
}

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
  /**
   * How the macOS app bundle can be replaced: whole, when it and the folder holding it can
   * be written, or its `Contents`, when only it can; undefined when neither. See
   * ./mac.ts.
   */
  readonly bundleSwap: "whole" | "contents" | undefined
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
 * How a build updates: which updater, and whether it installs or only tells. A portable
 * build only tells; see `portableOf`. `allow` marks a macOS copy that only tells because
 * the person can't write its bundle, which an administrator can hand to them once.
 */
export type UpdatePlan = {
  readonly kind: UpdaterKind
  readonly mode: UpdateMode
  readonly allow: boolean
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
 * - macOS installs when the app bundle is Developer ID signed, as an update is installed
 *   only when it is signed by the same team, and the bundle can be replaced (see
 *   `bundleSwap`); it tells otherwise. A signed copy that tells only because the person
 *   can't write its bundle may be handed to them by an administrator (`allow`). A
 *   portable one, outside Applications, only tells.
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
    kind === "mac"
      ? build.signed && build.bundleSwap !== undefined
      : kind === "appimage"
        ? build.appImageWritable
        : true
  return {
    kind,
    mode: installable && !portable ? "install" : "tell",
    allow: kind === "mac" && build.signed && !portable && build.bundleSwap === undefined,
  }
}

/**
 * Whether `codesign --display --verbose=2` output names a Developer ID signature. An
 * unsigned or ad-hoc signed bundle names none, and no update could be checked against it
 * after the whole archive was downloaded.
 */
export const developerIdSigned = (output: string): boolean =>
  /^Authority=Developer ID Application: /m.test(output)

// The part of a window that telling it of an update uses.
type Page = { send(channel: string, offer: UpdateOffer): void }

// Whether two offers say the same to a page: the kind, the version, a download's percent,
// and whether an administrator can let the copy install the release itself.
const sameOffer = (a: UpdateOffer, b: UpdateOffer): boolean =>
  a.kind === b.kind &&
  a.version === b.version &&
  (a.kind !== "downloading" || (b.kind === "downloading" && a.percent === b.percent)) &&
  (a.kind !== "available" || (b.kind === "available" && a.allow === b.allow))

/**
 * Remembers the last offer and tells every page of it: `offer` those open now, `request`
 * a page that started listening later, such as after a reload or in a new window. A
 * report of what the pages already know is dropped, and that includes the `percent` of a
 * `downloading` offer, so each whole percent a download reaches is told once; any other
 * replaces the last, a newer version and a `ready` update the app then could not install
 * alike. `pages` lists the windows showing the app's own UI. Only a `downloading` offer
 * carries a `percent`.
 */
export const trackOffer = <P extends Page>(pages: () => readonly P[]) => {
  let last: UpdateOffer | undefined
  return {
    current: (): UpdateOffer | undefined => last,
    offer: (next: UpdateOffer): void => {
      const offer = parseUpdateOffer(next)
      if (offer === undefined || (last !== undefined && sameOffer(last, offer))) return
      last = offer
      for (const page of pages()) page.send(updateOfferChannel, offer)
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
 * Answers the app's own pages: a request for the last offer, the request to open its
 * release page or, on macOS, to let this copy install updates itself (`allow`; see
 * `UpdatePlan`), and those about the update channel. `window` names the
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
    openPage,
    allow,
    channel,
    setChannel,
  }: {
    readonly window: (event: IpcMainEvent | IpcMainInvokeEvent) => Window | undefined
    readonly request: (window: Window) => void
    readonly openPage: () => void
    readonly allow: () => void
    readonly channel: () => UpdateChannel
    readonly setChannel: (channel: UpdateChannel) => void
  },
): void => {
  ipc.on(updateRequestChannel, (event) => {
    const target = window(event)
    if (target !== undefined) request(target)
  })
  ipc.on(openUpdatePageChannel, (event) => {
    if (window(event) !== undefined) openPage()
  })
  ipc.on(allowUpdatesChannel, (event) => {
    if (window(event) !== undefined) allow()
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
 * A quit that leaves an update waiting uninstalled: for the system ending the session,
 * which may kill a silent installer or a swap halfway. Ordinary quits install. On macOS,
 * where the app swaps the bundle itself, `updater` names the switch that swap reads.
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
 * orderly quits are closing the last window and the menu's Quit,
 * and both are marked before the quit begins; any other, a signal, finds the mark
 * missing. Switching off is one way: nothing switches it on again.
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
  /** Headers sent with the requests of checks and downloads. */
  requestHeaders: OutgoingHttpHeaders | null
  logger: {
    info(message?: unknown): void
    warn(message?: unknown): void
    error(message?: unknown): void
  } | null
  on(
    event: "update-available",
    listener: (info: { readonly version: string; readonly files?: unknown }) => void,
  ): unknown
  on(
    event: "update-downloaded",
    listener: (info: { readonly version: string; readonly downloadedFile?: string }) => void,
  ): unknown
  on(
    event: "download-progress",
    listener: (progress: { readonly percent: number }) => void,
  ): unknown
  on(event: "update-not-available", listener: () => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  /** Replaces where releases are looked for. */
  setFeedURL(
    feed:
      | { readonly provider: "github"; owner: string; repo: string }
      | { readonly provider: "generic"; url: string; useMultipleRangeRequest: boolean },
  ): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  /** The install that quitting runs; see `checkForUpdates`. */
  install?: (isSilent?: boolean, isForceRunAfter?: boolean) => boolean
}

/**
 * Checks for updates shortly after launch and every hour; a check that fails,
 * offline, rate limited, or on a channel with no release yet, is logged and the next one
 * tries again. `channel` decides which releases count: `stable` is GitHub's latest
 * release that is not a prerelease, `experimental` every release. Updating never downgrades.
 *
 * In `install` mode it downloads what it finds and installs it when the app next quits.
 * `offer` is told the update is `downloading` at each whole percent electron-updater
 * reports, from the first, then `ready` once downloaded and, where the app gives
 * `prepare`, once that has made the download ready to put in place. A download already on disk from
 * an earlier launch reports none, and is `ready` at once. A release whose download fails
 * is tried again, once in a run, by a check `retryCheckMs` later; after that the schedule
 * tries it. Meanwhile it is offered as `retrying`, which the page shows nothing for, once
 * its progress or an update it replaces was offered; one that failed before either goes
 * untold, as a failed check does. Should the early retry fail too, it is offered as
 * `available`, to fetch from the release page, until a download of it gets going. The one
 * exception is the release `failedVersion`
 * names, the version an earlier install failed on: it is only told of, as `available`,
 * and not downloaded again, so a failing install does not come back at every launch. A
 * newer release installs as usual.
 *
 * One download is tracked at a time, whether the first or one in place of an update
 * already downloaded. While it is under way a release found is left to the next check, and
 * only its progress is offered. The schedule goes on once an update has downloaded, and a
 * newer release it finds replaces that update, so one quit lands on the latest
 * release. No release file carries a version in its name, so electron-updater downloads
 * the newer one beside the waiting file and renames it over that file once complete;
 * quitting meanwhile installs the waiting update on Windows and Linux. The offer turns
 * from `ready` to `downloading` the newer release as its progress comes in, so the page
 * shows it again. Should it fail, the waiting file is likely gone
 * with it, as electron-updater clears its download folder then: the newer release is
 * offered as `retrying` until the retry downloads it.
 *
 * On macOS the app installs the update itself as the app quits (see ./mac.ts), so
 * electron-updater only downloads it: `prepare` hears of each download, its version and
 * file, and the update stays `downloading`, at the last percent reported, until that is
 * done, and is `ready` then. Should `prepare` reject the download, as one not signed by
 * the same team (`rejected` tells), the release counts as one whose install failed:
 * `installFailed` hears of it, it is offered as `available`, and it is not downloaded
 * again. Any other failure, as a full disk, is a failed download: it is offered as
 * `retrying` and tried again like one. A newer release prepared meanwhile replaces it.
 *
 * An error raised while installing fails the install: installing on quit is switched
 * off, so the same failing install is not tried at every quit, `installFailed` hears of
 * the version, and `offer` is told the update is only `available`. Installing is when
 * the updater's `install` (quitting) has been called, which this wraps to know and to
 * tell `installing` of the version first; any other error, such as a check still in
 * flight failing offline, is only logged.
 *
 * In `tell` mode it downloads and installs nothing, and tells `offer` each release newer
 * than this build is `available`, saying so (`allow`) when an administrator can let the
 * copy install updates itself; the schedule goes on, so a newer release replaces the offer.
 *
 * Where a check looks depends on `feed`. With one, a check reads the channel's address on
 * novadeck.dev (`feedUrl`), saying why it runs and what copy makes it (`checkHeaders`),
 * which is how the website counts active copies; the headers go with that check and
 * nothing else. A site that can't be reached or fails never blocks updating: a check
 * through it that fails, for whatever reason, is made again at once against GitHub's
 * releases, and the next check goes to novadeck.dev again. Its answer for `experimental` lags
 * GitHub's by up to a minute, or by hours should the site fall back to its own build's
 * record, which it distrusts after six hours; a wrong one, which only a bug of the site
 * gives, delays updates until it is fixed. Whichever feed answers, an `experimental` answer
 * from the website that names a release older than one offered or taken
 * for download within `experimentalTrustMs` is ignored, so a lagging answer never steps back
 * (per run, in memory); GitHub's answers and the stable channel's are taken as they are,
 * and an answer for a channel left during the check is dropped, the channel's check
 * then made again at once. The hold lasts while the newer release is offered or ready, not
 * after its download failed. The check after a failed download's first failure, whichever
 * that is, goes to GitHub alone, so a feed that checks well but downloads badly does not
 * fail the same way twice. Without `feed` a check uses the updater's own
 * configuration.
 *
 * `logger` hears electron-updater's own messages; without one they are dropped.
 *
 * `installNow` puts a waiting update in place at once, as the quit-time install would, for a
 * copy that is swapped while the app still runs (the AppImage); it returns whether it did. The
 * quit-time install then finds it done and does nothing.
 *
 * `setChannel` follows another channel from the next check, and makes one soon, unless the
 * schedule has ended. `stop` ends the schedule, after which no new download starts; one
 * under way goes on. Quitting stops it first.
 */
export const checkForUpdates = (
  updater: Updater,
  {
    mode,
    channel,
    failedVersion,
    allow = false,
    feed,
    prepare,
    rejected = () => true,
    offer,
    installStarted,
    runAfterInstall,
    installFailed,
    log,
    logger,
  }: {
    readonly mode: UpdateMode
    readonly channel: UpdateChannel
    /** The version installing failed on in an earlier launch, if it did. */
    readonly failedVersion?: string | undefined
    /** Whether an administrator can let a copy in `tell` mode install updates itself. */
    readonly allow?: boolean | undefined
    /** Checks through novadeck.dev, falling back to GitHub; see above. */
    readonly feed?: UpdateFeed | undefined
    /** On macOS, makes a download ready for the app to put in place on quitting. */
    readonly prepare?:
      | ((update: { readonly version: string; readonly file: string }) => Promise<void>)
      | undefined
    /** Whether a failure of `prepare` rejects the release for good, rather than once. */
    readonly rejected?: ((error: unknown) => boolean) | undefined
    readonly offer: (offer: UpdateOffer) => void
    /** Hears the version an install on quitting is about to put in place. */
    readonly installStarted?: ((version: string) => void) | undefined
    /**
     * Asked as the quit-time install starts whether the installer should start the app
     * once it is done, because the person opened Novadeck while it was quitting. Asked only
     * where an installer runs after the app has gone (Windows); see `installNow` for the
     * AppImage, which is swapped before.
     */
    readonly runAfterInstall?: (() => boolean) | undefined
    readonly installFailed: (version: string) => void
    readonly log: (message: string, error: unknown) => void
    readonly logger?: Updater["logger"] | undefined
  },
): {
  readonly setChannel: (channel: UpdateChannel) => void
  readonly stop: () => void
  readonly installNow: () => boolean
} => {
  // Downloads are asked for, to leave out the release that failed to install.
  updater.autoDownload = false
  // electron-updater installs on quitting, but on macOS, where the app does: there its
  // updater hands a download to Squirrel.Mac only while this is on.
  updater.autoInstallOnAppQuit = mode === "install" && prepare === undefined
  updater.allowPrerelease = channel === "experimental"
  // The channel the next check follows, which the generic feed needs: it has no notion of
  // prereleases, so the address itself names the channel.
  let following = channel
  updater.logger = logger ?? { info: () => {}, warn: () => {}, error: () => {} }

  let downloaded: { readonly version: string } | undefined
  // The download under way, the first or a newer release's in place of `downloaded`, with
  // the whole percent last offered for it (-1 before any) and whether it came through.
  let loading:
    | {
        readonly version: string
        percent: number
        readonly done: Promise<boolean>
      }
    | undefined
  // The download `prepare` is making ready, before it is `downloaded`.
  let preparing: string | undefined
  // The release not to download again: the one an install failed on, here or earlier.
  let failedOn = failedVersion
  // The release last offered in `tell` mode or taken for download, on the channel then
  // followed and when (by the monotonic clock, so a clock change moves nothing), which an
  // older answer from the website does not replace; see `experimentalTrustMs`. Held on `stable`,
  // it does not protect after a switch to `experimental`: the guard is for `experimental` alone.
  let held:
    | { readonly version: string; readonly channel: UpdateChannel; readonly at: number }
    | undefined
  // Errors reported while a check through novadeck.dev is in flight, not yet logged.
  const deferred: unknown[] = []
  // The channel the check in flight was made for.
  let checkedChannel = channel
  // Once an install has begun the app is on its way out, so the mark never goes back.
  let installing = false
  // Whether the install returned having put the update in place, as the AppImage's does as
  // the quit begins. Errors after that belong to whatever else is still in flight.
  let placed = false
  let failed = false
  const original: unknown = updater.install
  if (typeof original === "function")
    Object.assign(updater, {
      install: (...args: unknown[]): unknown => {
        installing = true
        if (downloaded !== undefined) installStarted?.(downloaded.version)
        // (silent, force run): the installer starts the app when it is done only if asked.
        const [silent, forceRun] = args
        return Reflect.apply(
          original,
          updater,
          runAfterInstall?.() ? [silent ?? false, true] : [silent, forceRun],
        )
      },
    })
  updater.on("error", (error) => {
    // An install fails once; an error reported after it adds nothing to log or mark.
    if (failed) return
    if (downloaded === undefined || !installing || placed) {
      // An install that has put the update in place is done: what is reported after it, by a
      // check or a download still in flight as the quit began, is theirs, not the install's.
      // A check through novadeck.dev that fails is logged as it falls back to GitHub. Which
      // error is the check's is known when it rejects, so the others, a download's, wait
      // for that and are logged then.
      if (checking && via === "novadeck" && !ended) return void deferred.push(error)
      return log("The update check failed.", error)
    }
    log("Installing the update failed.", error)
    failed = true
    failedOn = downloaded.version
    updater.autoInstallOnAppQuit = false
    installFailed(downloaded.version)
    offer({ kind: "available", version: downloaded.version })
  })
  updater.on("update-available", (info) => {
    // The answer of a check made for a channel the person has since left is dropped.
    if (checkedChannel !== following) return
    // Never a step back to an older experimental release the website names: its `experimental` answer can
    // lag GitHub's (by hours, should the site fall back to its build's record), and following
    // it would replace a newer release already offered or fetched. This holds for
    // `experimentalTrustMs`, after which a withdrawn release can give way. GitHub's answers and
    // the stable channel's are taken as they are.
    // (isNewerVersion compares prerelease tags as text; the releases' versions have none.)
    if (
      via === "novadeck" &&
      following === "experimental" &&
      held?.channel === following &&
      performance.now() - held.at < experimentalTrustMs &&
      isNewerVersion(held.version, info.version)
    )
      return
    if (mode === "tell") {
      held = { version: info.version, channel: following, at: performance.now() }
      return offer({ kind: "available", version: info.version, ...(allow ? { allow } : {}) })
    }
    // A release found while a download is under way waits for the next check.
    if (
      ended ||
      loading !== undefined ||
      info.version === downloaded?.version ||
      info.version === preparing
    )
      return
    if (info.version === failedOn) {
      // A ready update stays ready rather than give way to the release that failed.
      if (downloaded === undefined) offer({ kind: "available", version: info.version })
      return
    }
    const { version } = info
    // Where the answer came from decides what its relative addresses mean, and nothing it
    // names may lie off GitHub's release downloads; see `filesFromGitHub`.
    if (feed !== undefined) {
      const base =
        via === "novadeck"
          ? feedUrl(following, feed.site)
          : (releaseDownloadsUrl(feed.repository, version) ?? "")
      if (!filesFromGitHub(info, feed.repository, base, via === "novadeck" ? feed.site : undefined)) {
        log(`The update to ${version} names a file outside GitHub's release downloads.`, undefined)
        if (downloaded === undefined) offer({ kind: "available", version })
        return
      }
    }
    held = { version, channel: following, at: performance.now() }
    // The headers describe the check; the download of what it found carries none.
    updater.requestHeaders = null
    // A failed download is reported through the error event, which logs it.
    const current = {
      version,
      percent: -1,
      done: updater.downloadUpdate().then(
        () => true,
        () => {
          // Failing after it was reported in, as when copying its blockmap fails, leaves
          // the download where it is, ready or being prepared.
          if (downloaded?.version === version || preparing === version) return !failed
          // The waiting file, if any, is likely gone with the failed download, so the
          // page is told it is being retried, unless it has heard of neither. Once the
          // early retry failed too, the person is told to fetch it themselves, so a copy
          // whose downloads keep failing does not fall behind unseen; the schedule still
          // tries it, and a download that gets going takes the offer back.
          if (retried.has(version)) offer({ kind: "available", version })
          else if (current.percent >= 0 || downloaded !== undefined)
            offer({ kind: "retrying", version })
          downloaded = undefined
          if (held?.version === version) held = undefined
          if (!ended && !retried.has(version)) {
            // The one retry of a version goes to GitHub alone, so a feed that checks well
            // but downloads badly does not fail the same way twice; a copy whose downloads
            // keep failing goes back to the website afterwards.
            githubOnly = true
            retried.add(version)
            clearTimeout(retry)
            retry = setTimeout(() => check("retry"), retryCheckMs)
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
    offer({ kind: "downloading", version: loading.version, percent: whole })
  })
  updater.on("update-downloaded", ({ version, downloadedFile }) => {
    if (prepare === undefined) {
      downloaded = { version }
      return offer({ kind: "ready", version })
    }
    // Only the latest download counts: one prepared after it was replaced is let go.
    preparing = version
    const prepared =
      downloadedFile === undefined
        ? Promise.reject(new Error("The download names no file."))
        : prepare({ version, file: downloadedFile })
    void prepared.then(
      () => {
        if (preparing !== version) return
        preparing = undefined
        downloaded = { version }
        offer({ kind: "ready", version })
      },
      (error: unknown) => {
        if (preparing !== version) return
        preparing = undefined
        log("Preparing the update failed.", error)
        if (rejected(error)) {
          failedOn = version
          installFailed(version)
          return offer({ kind: "available", version })
        }
        // Tried again as a failed download is, from the copy electron-updater keeps; once
        // the early retry failed too, the person is told to fetch it themselves.
        offer({ kind: retried.has(version) ? "available" : "retrying", version })
        if (!ended && !retried.has(version)) {
          retried.add(version)
          clearTimeout(retry)
          retry = setTimeout(() => check("retry"), retryCheckMs)
        }
      },
    )
  })

  // Where the check in flight or last made looked, which the error handler needs to know
  // whether an error is a novadeck.dev check's, that falls back to GitHub.
  let via: "novadeck" | "github" = "github"
  // Whether the next check skips novadeck.dev, as a download failed and is tried again.
  let githubOnly = false
  let checking = false
  const checkThroughFeed = async (reason: CheckReason, from: UpdateFeed): Promise<void> => {
    if (!githubOnly) {
      via = "novadeck"
      // The website sends the files on to GitHub, which does not serve multipart ranges, as
      // GitHubProvider knows; asking for them would fail every differential download.
      updater.setFeedURL({
        provider: "generic",
        url: feedUrl(following, from.site),
        useMultipleRangeRequest: false,
      })
      updater.requestHeaders = checkHeaders(reason, from.facts)
      try {
        await updater.checkForUpdates()
        return
      } catch (error) {
        // A quit ends the schedule; no new request starts after it.
        if (ended) throw error
        const own = deferred.indexOf(error)
        if (own >= 0) deferred.splice(own, 1)
        log("The update check through novadeck.dev failed; trying GitHub.", error)
      }
    }
    githubOnly = false
    via = "github"
    updater.requestHeaders = null
    updater.setFeedURL({ provider: "github", ...from.repository })
    await updater.checkForUpdates()
  }
  const check = (reason: CheckReason): void => {
    // The updater reports a failed check through its error event, which logs it.
    if (feed === undefined) {
      checkedChannel = following
      return void updater.checkForUpdates().catch(() => {})
    }
    if (checking) return
    checking = true
    checkedChannel = following
    checkThroughFeed(reason, feed)
      .catch(() => {})
      .finally(() => {
        checking = false
        updater.requestHeaders = null
        for (const error of deferred.splice(0)) log("The update check failed.", error)
        // A channel switched meanwhile found its check turned away, and the answer of this
        // one was dropped: check again at once.
        if (!ended && checkedChannel !== following) check("switch")
      })
  }
  let ended = false
  let first = setTimeout(() => check("launch"), firstCheckMs)
  const every = setInterval(() => check("interval"), checkIntervalMs)
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
      updater.allowPrerelease = next === "experimental"
      following = next
      if (ended) return
      clearTimeout(first)
      first = setTimeout(() => check("switch"), switchCheckMs)
    },
    stop,
    installNow: () => {
      // Only a download waiting, in a copy that installs on quitting and has not failed.
      if (
        mode !== "install" ||
        downloaded === undefined ||
        installing ||
        failed ||
        !updater.autoInstallOnAppQuit ||
        typeof updater.install !== "function"
      )
        return false
      const done = updater.install(true, false)
      placed = done
      return done
    },
  }
}
