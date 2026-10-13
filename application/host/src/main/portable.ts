import type { InstallResult, PortableState } from "@novadeck/protocol/bridge"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import { installAppChannel, openInstalledChannel, portableChannel } from "../bridge.js"
import { newerCopy, type InstalledCopy, type InstallOutcome } from "./install-linux.js"

/**
 * How an install went, as the platform reports it: the copy now installed, a newer
 * installed copy found and left alone (`image`, of `version`), why nothing was installed,
 * or `leaving`, when the platform itself is already ending this app to start the installed
 * copy, as macOS does after moving the app to Applications.
 */
export type PortableInstall =
  | InstallOutcome
  | { readonly kind: "newer"; readonly image: string; readonly version: string }
  | { readonly kind: "leaving" }

/** What installing from a portable copy, and leaving for the installed one, ask of the app. */
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
   * when `target` is undefined.
   */
  readonly install: (target: string | undefined) => Promise<PortableInstall>
  /** The shutdown quitting runs: pages save, the runner ends its shells. */
  readonly shutdown: () => Promise<void>
  /**
   * Starts the installed copy `image` in place of this one and ends this process; false if
   * it could not start.
   */
  readonly start: (image: string) => Promise<boolean>
  /** Tells the person that the installed copy at `image` would not start. */
  readonly alert: (image: string) => Promise<void>
  /** Whether the app is already on its way out, as a quit or a restart into an update is. */
  readonly stopping: () => boolean
  /** How long after the installed copy started this one waits to be gone before it quits. */
  readonly fallbackMs: number
  readonly quit: () => void
  readonly log: (message: string, error: unknown) => void
}

/** The page's view of a portable copy: what it is and what installing does. */
export type PortableInstaller = {
  readonly state: () => PortableState
  readonly install: () => Promise<InstallResult>
  readonly openInstalled: () => void
}

const quitting: InstallResult = {
  kind: "failed",
  reason: "Novadeck is quitting.",
}

/**
 * Installs the app from a portable copy and leaves for it. `install` first looks at the
 * installed copies: one newer than this copy is left alone, since this copy would
 * replace it with an older app that could not open the data the newer one may have
 * upgraded, and the answer is `newer`, which `openInstalled` then acts on. Otherwise the
 * app is installed from this very copy, over the installed copy there is, else where the
 * platform installs, and the answer is `installing`: this copy
 * then shuts down as quitting does and starts the installed one. On macOS the install is
 * Electron's move to Applications, which quits this app and starts the moved one itself,
 * through the quit that shuts down; the answer is then `installing` at once, and a quit
 * follows after `fallbackMs` should the app somehow still run. Should the installed copy not start,
 * the person is told, and the app quits, as the shells are gone by then; it also quits
 * should it somehow still be running `fallbackMs` after the installed copy started. An
 * installed copy that could not be looked at is not replaced, nor is anything installed
 * while the app is quitting; either answers `failed`. A failed install says why and
 * changes nothing. A second request while one is under way gets that one's answer, which may
 * be `newer` or `failed`, and does nothing more; once the copy began leaving, it answers
 * `installing`. A copy that is not portable installs
 * nothing.
 */
export const portableInstaller = (host: PortableHost): PortableInstaller => {
  let under: Promise<InstallResult> | undefined
  let leaving = false
  let newer: string | undefined

  const leave = (image: string): void => {
    if (leaving) return
    leaving = true
    void host
      .shutdown()
      .catch((error: unknown) => host.log("Shutting down failed.", error))
      .then(() => host.start(image))
      .then((started) => {
        if (started) return void setTimeout(host.quit, host.fallbackMs)
        return host.alert(image).then(host.quit)
      })
      .catch(host.quit)
  }

  const run = async (): Promise<InstallResult> => {
    const copies = await host.find()
    const copy = newerCopy(copies, host.version)
    if (copy) {
      newer = copy.image
      return { kind: "newer", version: copy.version }
    }
    newer = undefined
    // On Linux an installed copy is replaced where it is, the installer's own before
    // Homebrew's, so no second copy appears; `find` lists them in that order. (On macOS
    // Electron decides where the copy goes; see `renamedMoveReason`.) One that could not be
    // looked at may be a newer app, so it is left as it is.
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
    const outcome = await host.install(replaced?.image)
    if (outcome.kind === "failed") return outcome
    if (outcome.kind === "newer") {
      newer = outcome.image
      return { kind: "newer", version: outcome.version }
    }
    if (outcome.kind === "leaving") {
      leaving = true
      setTimeout(host.quit, host.fallbackMs)
      return { kind: "installing" }
    }
    // The copy took a while: should the person have quit meanwhile, stay quit.
    if (host.stopping()) return quitting
    leave(outcome.image)
    return { kind: "installing" }
  }

  return {
    state: () =>
      host.portable
        ? { portable: true, version: host.version, run: host.run }
        : { portable: false },
    install: () => {
      if (!host.portable)
        return Promise.resolve({
          kind: "failed",
          reason: "This copy of Novadeck is installed.",
        })
      if (leaving) return Promise.resolve({ kind: "installing" })
      if (host.stopping()) return Promise.resolve(quitting)
      under ??= run()
        .catch((error: unknown): InstallResult => {
          host.log("Installing failed.", error)
          return { kind: "failed", reason: "Something went wrong." }
        })
        .finally(() => {
          under = undefined
        })
      return under
    },
    openInstalled: () => {
      if (newer !== undefined && !host.stopping()) leave(newer)
    },
  }
}

/** What a launch of a portable copy does about an installed copy that is newer. */
export type NewerInstalledCheck = {
  readonly portable: boolean
  readonly version: string
  readonly find: () => Promise<readonly InstalledCopy[]>
  /** Tells the person of the newer `version`; true if they want it opened, false to quit. */
  readonly ask: (version: string) => Promise<boolean>
  /**
   * Starts the installed copy `image` in place of this one and ends this process; false if
   * it could not start.
   */
  readonly start: (image: string) => Promise<boolean>
  /** Tells the person that the installed copy at `image` would not start. */
  readonly alert: (image: string) => Promise<void>
  readonly quit: () => void
  readonly log: (message: string, error: unknown) => void
}

/**
 * Before a portable copy starts anything, checks whether an installed copy is newer.
 * Then this copy must not run: the newer one may have upgraded the database, which an
 * older runner refuses to open, so the person is told and may open the installed copy,
 * or quit. Returns whether the launch is over, which it is when a newer copy exists,
 * whichever the person chooses, and not when none is found or the copies cannot be
 * listed; then the launch goes on. A copy that could not be looked at counts as none:
 * the runner refuses a workspace that is too new, which is the fallback.
 */
export const leaveForNewerInstalled = async (check: NewerInstalledCheck): Promise<boolean> => {
  if (!check.portable) return false
  let copy: ReturnType<typeof newerCopy>
  try {
    copy = newerCopy(await check.find(), check.version)
  } catch (error) {
    check.log("The installed copies could not be looked at.", error)
    return false
  }
  if (!copy) return false
  if (await check.ask(copy.version)) {
    if (await check.start(copy.image)) return true
    await check.alert(copy.image)
  }
  check.quit()
  return true
}

type PortableIpc = {
  on(channel: string, listener: (event: IpcMainEvent) => void): unknown
  handle(channel: string, listener: (event: IpcMainInvokeEvent) => unknown): unknown
}

/**
 * Answers the app's own pages whether this is a portable copy, and their requests to
 * install from it and to open the installed copy found newer. `window` names the window
 * of a request from the main frame of the app's own page, or undefined for any other
 * sender, which is told this is not a portable copy, may not install, and is ignored when
 * it asks to open. The requests carry no value.
 */
export const registerPortableIpc = <Window>(
  ipc: PortableIpc,
  {
    window,
    installer,
  }: {
    readonly window: (event: IpcMainEvent | IpcMainInvokeEvent) => Window | undefined
    readonly installer: PortableInstaller
  },
): void => {
  ipc.handle(portableChannel, (event): PortableState =>
    window(event) === undefined ? { portable: false } : installer.state(),
  )
  ipc.handle(installAppChannel, (event): Promise<InstallResult> | InstallResult =>
    window(event) === undefined
      ? { kind: "failed", reason: "Installing is not allowed from here." }
      : installer.install(),
  )
  ipc.on(openInstalledChannel, (event) => {
    if (window(event) !== undefined) installer.openInstalled()
  })
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
 * lock on the data folder is let go first so the child can take it; this process has
 * shut down by now. Resolves true
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
  readonly exit: () => void
  readonly log: (message: string, error: unknown) => void
}): Promise<boolean> =>
  new Promise((resolve) => {
    if (!runnable(image)) {
      log("The installed copy has no executable to start.", image)
      return resolve(false)
    }
    releaseLock()
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
      child.once("error", (error) => {
        log("The installed copy did not start.", error)
        resolve(false)
      })
      child.once("spawn", () => {
        child.unref()
        exit()
        resolve(true)
      })
    } catch (error) {
      log("The installed copy did not start.", error)
      resolve(false)
    }
  })
