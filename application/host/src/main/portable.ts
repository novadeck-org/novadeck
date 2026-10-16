import type { InstallProgress, InstallResult, PortableState } from "@novadeck/protocol/bridge"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import {
  installAppChannel,
  installProgressChannel,
  portableChannel,
  portableStateChannel,
} from "../bridge.js"
import { isNewerVersion } from "./applications-folder.js"
import {
  currentOrNewerCopy,
  newerCopy,
  type InstalledCopy,
  type InstallOutcome,
} from "./install-linux.js"

/**
 * How an install went, as the platform reports it: the copy now installed, a newer
 * installed copy found and left alone (`version`), or why nothing was installed.
 */
export type PortableInstall = InstallOutcome | { readonly kind: "newer"; readonly version: string }

/** What installing from a portable copy asks of the app. */
export type PortableHost = {
  /** Whether this copy is portable; see `portableOf`. */
  readonly portable: boolean
  /** This build's version. */
  readonly version: string
  /** Names this run of the app, which a page that opens again within it can tell. */
  readonly run: string
  /** What to do about an installed copy that could not be checked, as a sentence. */
  readonly uncheckedAdvice: string
  /** The copies of the app already installed, with their versions. */
  readonly find: () => Promise<readonly InstalledCopy[]>
  /**
   * Installs this copy over `target`, an installed copy, or where the platform installs
   * when `target` is undefined, telling `progress` how it goes. Starts nothing: this copy
   * keeps running.
   */
  readonly install: (
    target: string | undefined,
    progress: (progress: InstallProgress) => void,
  ) => Promise<PortableInstall>
  /** Whether the app is already on its way out, as a quit is. */
  readonly stopping: () => boolean
  readonly log: (message: string, error: unknown) => void
}

/** The page's view of a portable copy: what it is and what installing does. */
export type PortableInstaller = {
  readonly state: () => PortableState
  readonly install: (progress: (progress: InstallProgress) => void) => Promise<InstallResult>
}

const quitting: InstallResult = {
  kind: "failed",
  reason: "Novadeck is quitting.",
}

/**
 * Installs the app from a portable copy while it keeps running; nothing is restarted,
 * quit or started. `install` first looks at the installed copies: one newer than this
 * copy is left alone, since this copy would replace it with an older app that could not
 * open the data the newer one may have upgraded, and the answer is `newer`. An installed
 * copy that could not be looked at is not replaced either; that answers `failed`, as does
 * an install while the app is quitting. Otherwise the app is installed from this very
 * copy, over the installed copy there is, else where the platform installs, and the
 * answer is `installed`; the installed copy takes effect when the person next opens
 * Novadeck. A failed install says why and changes nothing. A second request while one is
 * under way gets that one's answer, and after a success the same answer without
 * installing again. A copy that is not portable installs nothing.
 */
export const portableInstaller = (host: PortableHost): PortableInstaller => {
  let under: Promise<InstallResult> | undefined
  let done: InstallResult | undefined
  // Whether this run installed, or found a newer installed copy: either way there is
  // nothing more for the page to offer.
  let settled = false

  const run = async (progress: (progress: InstallProgress) => void): Promise<InstallResult> => {
    const copies = await host.find()
    const copy = newerCopy(copies, host.version)
    if (copy) return { kind: "newer", version: copy.version }
    // On Linux an installed copy is replaced where it is, the installer's own before
    // Homebrew's, so no second copy appears; `find` lists them in that order. One that
    // could not be looked at may be a newer app, so it is left as it is.
    const [replaced] = copies
    if (replaced?.unchecked) {
      host.log("The installed copy could not be checked.", replaced.image)
      return {
        kind: "failed",
        reason:
          "The installed copy could not be checked, so it was left as it is. " +
          host.uncheckedAdvice,
      }
    }
    if (host.stopping()) return quitting
    const outcome = await host.install(replaced?.image, progress)
    if (outcome.kind === "failed") return outcome
    if (outcome.kind === "newer") return outcome
    return { kind: "installed" }
  }

  return {
    state: () =>
      host.portable
        ? { portable: true, version: host.version, run: host.run, installed: settled }
        : { portable: false },
    install: (progress) => {
      if (!host.portable)
        return Promise.resolve({
          kind: "failed",
          reason: "This copy of Novadeck is installed.",
        })
      if (done !== undefined) return Promise.resolve(done)
      if (host.stopping()) return Promise.resolve(quitting)
      under ??= run(progress)
        .catch((error: unknown): InstallResult => {
          host.log("Installing failed.", error)
          return { kind: "failed", reason: "Something went wrong." }
        })
        .then((result) => {
          if (result.kind === "installed") done = result
          if (result.kind !== "failed") settled = true
          return result
        })
        .finally(() => {
          under = undefined
        })
      return under
    },
  }
}

/** What a launch of a portable copy does about an installed copy of the same version or newer. */
export type InstalledCopyCheck = {
  readonly portable: boolean
  readonly version: string
  readonly find: () => Promise<readonly InstalledCopy[]>
  /**
   * Starts the installed copy `image` in place of this one and ends this process; false if
   * it could not start.
   */
  readonly start: (image: string) => Promise<boolean>
  /** Tells the person that the installed copy at `image` would not start. */
  readonly alert: (image: string) => Promise<void>
  /** Whether this copy redirected a launch to an installed copy of the same version just now. */
  readonly recentRedirect: () => boolean
  /** Notes that this copy is redirecting a launch to an installed copy of the same version. */
  readonly markRedirect: () => void
  readonly quit: () => void
  readonly log: (message: string, error: unknown) => void
}

/**
 * Before a portable copy starts anything, checks for an installed copy of the same
 * version or a newer one, and if there is one starts it in place of this launch, without
 * asking: the person opened Novadeck, and the installed copy is the one they keep. A
 * newer copy must also not be shadowed by this one: it may have upgraded the database,
 * which an older runner refuses to open. So if a newer copy will not start, the person is
 * told and this copy quits; if one of the same version will not start, this copy carries
 * on, as it can open the same workspace. Returns whether the launch is over, which it is
 * when the installed copy started, or this copy quit, and not when none is found, only
 * an older or unchecked copy exists, or the copies cannot be listed; then the launch goes
 * on. A copy that could not be looked at counts as none: the runner refuses a workspace
 * that is too new, which is the fallback.
 */
export const leaveForNewerInstalled = async (check: InstalledCopyCheck): Promise<boolean> => {
  if (!check.portable) return false
  let copy: ReturnType<typeof currentOrNewerCopy>
  try {
    copy = currentOrNewerCopy(await check.find(), check.version)
  } catch (error) {
    check.log("The installed copies could not be looked at.", error)
    return false
  }
  if (!copy) return false
  const same = !isNewerVersion(copy.version, check.version)
  // An installed copy of the same version that the system starts and ends at once (a
  // quarantined or damaged bundle) would make every launch open nothing; so a launch soon
  // after a redirect stays here. A newer copy is never skipped: this one may not open its data.
  if (same && check.recentRedirect()) {
    check.log("Redirected to the installed copy just now; carrying on in this one.", copy.image)
    return false
  }
  if (same) check.markRedirect()
  if (await check.start(copy.image)) return true
  if (same) {
    check.log("The installed copy did not start; carrying on in this one.", copy.image)
    return false
  }
  await check.alert(copy.image)
  check.quit()
  return true
}

/** The files a redirect marker uses. */
export type MarkerFiles = {
  /** When the file was last written, in ms since the epoch; throws where there is none. */
  readonly modified: (file: string) => number
  readonly write: (file: string) => void
  readonly remove: (file: string) => void
}

/**
 * The note a portable copy leaves in the data folder when it redirects to an installed copy
 * of the same version, which the installed copy clears as it starts: `recent` is true
 * only if a redirect was made within `windowMs` and the installed copy has not started
 * since. So a launch that follows a redirect the installed copy never answered stays in
 * the portable copy, and one after the installed copy ran and was quit redirects again.
 * Failures to read, write or clear are not fatal: the note is then absent or stale.
 */
export const redirectMarker = (
  file: string,
  windowMs: number,
  files: MarkerFiles,
  now: () => number,
  log: (message: string, error: unknown) => void,
) => ({
  recent: (): boolean => {
    try {
      return now() - files.modified(file) < windowMs
    } catch {
      return false
    }
  },
  mark: (): void => {
    try {
      files.write(file)
    } catch (error) {
      log("The redirect was not noted.", error)
    }
  },
  clear: (): void => {
    try {
      files.remove(file)
    } catch (error) {
      log("The redirect note was not cleared.", error)
    }
  },
})

type PortableIpc = {
  on(channel: string, listener: (event: IpcMainEvent) => void): unknown
  handle(channel: string, listener: (event: IpcMainInvokeEvent) => unknown): unknown
}

/** A page that install progress and the portable state are sent to. */
export type ProgressTarget = { send(channel: string, value: unknown): void }

/**
 * Answers the app's own pages whether this is a portable copy, and their requests to
 * install from it, telling every page of `pages` how the install goes. `window` names
 * the window of a request from the main frame of the app's own page, or undefined for any
 * other sender, which is told this is not a portable copy and may not install. The
 * requests carry no value.
 */
export const registerPortableIpc = <Window>(
  ipc: PortableIpc,
  {
    window,
    pages,
    installer,
  }: {
    readonly window: (event: IpcMainEvent | IpcMainInvokeEvent) => Window | undefined
    readonly pages: () => readonly ProgressTarget[]
    readonly installer: PortableInstaller
  },
): void => {
  ipc.handle(portableChannel, (event): PortableState =>
    window(event) === undefined ? { portable: false } : installer.state(),
  )
  ipc.handle(installAppChannel, (event): Promise<InstallResult> | InstallResult =>
    window(event) === undefined
      ? { kind: "failed", reason: "Installing is not allowed from here." }
      : installer
          .install((progress) => {
            for (const page of pages()) page.send(installProgressChannel, progress)
          })
          .then((result) => {
            // Every window learns of a settled install, not only the one that asked.
            if (result.kind !== "failed")
              for (const page of pages()) page.send(portableStateChannel, installer.state())
            return result
          }),
  )
}

const appImageVariables = new Set(["APPIMAGE", "APPDIR", "OWD", "ARGV0"])

// The variables AppRun prefixes with paths under the AppImage's mount.
const pathVariables = new Set(["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"])

// Whether `entry` is `folder` or lies under it.
const isUnder = (entry: string, folder: string): boolean => {
  const trimmed = entry.replace(/\/+$/u, "")
  return trimmed === folder || trimmed.startsWith(`${folder}/`)
}

/**
 * The environment the installed copy starts with: this one's, less the variables the
 * AppImage runtime set for this copy, which would make the installed one believe it runs
 * from this file and mount point, and less every entry of the path lists AppRun extended
 * that is in `mounts`, the folders this copy is mounted at. The mount goes away with this
 * copy, and something put at the same path afterwards would be searched first. A list
 * left empty is dropped.
 */
export const installedEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
  mounts: readonly string[],
): Record<string, string | undefined> => {
  // A mount of "/" would take every entry, and an empty one names nothing.
  const folders = mounts.map((mount) => mount.replace(/\/+$/u, "")).filter((mount) => mount !== "")
  const kept = Object.entries(env).filter(([name]) => !appImageVariables.has(name))
  return Object.fromEntries(
    kept.flatMap(([name, value]): [string, string | undefined][] => {
      if (value === undefined || !pathVariables.has(name)) return [[name, value]]
      const entries = value
        .split(":")
        .filter((entry) => !folders.some((folder) => isUnder(entry, folder)))
      return entries.length === 0 ? [] : [[name, entries.join(":")]]
    }),
  )
}

/** The part of a child process that starting the installed copy uses. */
export type StartedProcess = {
  once(event: "spawn", listener: () => void): unknown
  once(event: "error", listener: (error: Error) => void): unknown
  unref(): void
}

// What the shell runs to start the installed copy: it closes every file descriptor above
// the standard three, which Chromium leaves open to the child, and then becomes the app.
// The descriptors hold files in the mount of this copy's AppImage, which would then stay
// mounted as long as the installed app runs. Bash is needed: dash cannot name those above 9.
export const closeDescriptors =
  'for fd in /proc/$$/fd/*; do n=${fd##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done; exec "$0"'
// Where bash may be; the first that can run starts the copy.
const shells = ["/bin/bash", "/usr/bin/bash"]

/**
 * Starts the AppImage `image` in place of this process and ends it, as electron-updater
 * restarts an AppImage: a detached child with no arguments of this one's, which may carry
 * `--no-sandbox` for a system this copy ran on. Electron's own `relaunch` would not do on
 * Linux: its child inherits no-new-privileges, and the AppImage runtime then cannot mount
 * itself. The child starts through bash, which closes the descriptors it inherited and
 * becomes the app, or directly, logged, when there is no bash at /bin or /usr/bin. The
 * lock on the data folder is let go first so the child can take it, and taken back with
 * `reclaimLock` should the start fail (this process ends if that is refused). Resolves true
 * after `exit`, or false, having logged why, when the child could not be started, as with
 * a missing file or exec bit: `runnable` says whether a path can be executed, as bash
 * would only report that after the fact.
 */
export const startAppImage = ({
  image,
  env,
  mounts,
  spawn,
  runnable,
  releaseLock,
  reclaimLock,
  exit,
  log,
}: {
  readonly image: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** The folders this copy's AppImage is mounted at, which the child's environment drops. */
  readonly mounts: readonly string[]
  readonly spawn: (
    file: string,
    args: readonly string[],
    options: {
      readonly detached: true
      readonly stdio: "ignore"
      readonly env: Record<string, string | undefined>
    },
  ) => StartedProcess
  readonly runnable: (path: string) => boolean
  readonly releaseLock: () => void
  /** Takes the lock back after a failed start; false when another process holds it. */
  readonly reclaimLock: () => boolean
  readonly exit: () => void
  readonly log: (message: string, error: unknown) => void
}): Promise<boolean> =>
  new Promise((resolve) => {
    if (!runnable(image)) {
      log("The installed copy has no executable to start.", image)
      return resolve(false)
    }
    releaseLock()
    const failed = (error: unknown): void => {
      log("The installed copy did not start.", error)
      if (!reclaimLock()) exit()
      resolve(false)
    }
    try {
      const bash = shells.find(runnable)
      if (bash === undefined)
        log(
          "Starting the installed copy without bash, so this copy's mount stays while it runs.",
          image,
        )
      const [file, args] =
        bash === undefined ? [image, [] as string[]] : [bash, ["-c", closeDescriptors, image]]
      const child = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        env: installedEnvironment(env, mounts),
      })
      child.once("error", failed)
      child.once("spawn", () => {
        child.unref()
        exit()
        resolve(true)
      })
    } catch (error) {
      failed(error)
    }
  })
