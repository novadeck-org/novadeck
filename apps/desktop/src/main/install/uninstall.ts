import { posix, win32 } from "node:path"

import type { UninstallPlan, UninstallResult } from "@novadeck/protocol/bridge"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import { quitAppChannel, uninstallAppChannel, uninstallPlanChannel } from "../../bridge.js"
import { installLayout, type InstallLayout } from "./linux.js"
import { bundleOf } from "./mac.js"
import { reasonText } from "./reason.js"
import type { StartedProcess } from "./start.js"

/** What Homebrew's cask is called; the command that removes what it installed. */
export const brewUninstallCommand = "brew uninstall --cask novadeck"

// Where Homebrew keeps its Caskroom, which holds a cask's metadata even when the app itself
// was moved out of it. A cask's AppImage on Linux is a link into it.
const caskroomPrefixes = ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"]

/** Where the AppArmor profile the installer wrote lives, for the user `uid`. */
const apparmorProfile = (uid: number): string => `/etc/apparmor.d/novadeck-appimage-${uid}`

/**
 * The one-line command that removes the AppArmor profile (unloading it first, as it can
 * only be unloaded from its file), for the person to run when the app could not.
 */
const profileCommand = (profile: string): string =>
  `sudo apparmor_parser -R ${profile}; sudo rm -f ${profile}`

// What the privileged helper runs: unload the profile, then delete its file. The deletion
// is what counts; a profile that was not loaded is no reason to keep the file.
const profileScript = 'apparmor_parser -R "$1"; rm -f "$1"'

/** What uninstalling asks of the machine; the caller reads and does all of it. */
export type UninstallHost = {
  readonly platform: NodeJS.Platform
  /** Whether this is a packaged build; a development run has no install to remove. */
  readonly packaged: boolean
  /** Whether this copy is portable, which has no install either; see `portableOf`. */
  readonly portable: boolean
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  /** The running executable. */
  readonly execPath: string
  /** The folder Electron keeps this app's data in; the one the person's data lives in. */
  readonly userData: string
  /**
   * Where `userData` is unless a `--user-data-dir` moved it. Only the default folder is
   * the app's own to delete; one the person pointed elsewhere may hold anything.
   */
  readonly defaultUserData: string
  /** The user id the AppArmor profile is named for; undefined where there is none. */
  readonly uid: number | undefined
  /** The canonical form of a path, or undefined when it cannot be had. */
  readonly realpath: (path: string) => string | undefined
  readonly exists: (path: string) => boolean
  /** Where a symbolic link points, as written; undefined when `path` is not one. */
  readonly linkTarget: (path: string) => Promise<string | undefined>
  /** Removes a file or, with `recursive`, a folder; a path that is not there is no error. */
  readonly remove: (path: string, options: { readonly recursive: boolean }) => Promise<void>
  /** Removes a folder only if it is empty; any failure, such as it not being empty, is ignored. */
  readonly removeEmptyFolder: (path: string) => Promise<void>
  /** Moves a file or folder to the Trash; throws when it cannot. */
  readonly trash: (path: string) => Promise<void>
  /**
   * Runs the program with `args` as root through the system's own authentication prompt;
   * false when it is unavailable, the person declined, or it timed out.
   */
  readonly privileged: (args: readonly string[]) => Promise<boolean>
  /** Starts the Windows uninstaller `file` detached; false when it did not start. */
  readonly startUninstaller: (file: string) => Promise<boolean>
  /**
   * Removes the folders once this process has ended and the Windows `uninstaller` file is
   * gone, as a detached helper, since Chromium holds files in them while the app runs and
   * a cancelled uninstall must keep them; false when the helper did not start.
   */
  readonly removeAfterExit: (folders: readonly string[], uninstaller: string) => Promise<boolean>
  /** The shutdown quitting runs: pages save, the runner ends its shells. */
  readonly shutdown: () => Promise<void>
  readonly stopping: () => boolean
  readonly quit: () => void
  readonly log: (message: string, error: unknown) => void
}

// Every file and folder an uninstall of each kind of install would touch.
type Target =
  | {
      readonly kind: "linux"
      readonly layout: InstallLayout
      /** The folder the AppImage is in, removed only if it ends up empty. */
      readonly folder: string
      /** The AppArmor profile, when this user can have one. */
      readonly profile: string | undefined
      readonly dataFolders: readonly string[]
    }
  | {
      readonly kind: "mac"
      readonly bundle: string
      readonly dataFolders: readonly string[]
    }
  | {
      readonly kind: "windows"
      readonly uninstaller: string
      readonly dataFolders: readonly string[]
    }

const caskroomed = (path: string | undefined): boolean =>
  path !== undefined && path.split("/").includes("Caskroom")

// What kind of install this copy is, or why the app cannot remove it itself. A copy is
// identified only when it sits exactly where an installer puts it; anything else is not
// removed on a guess.
const identify = (host: UninstallHost): Target | UninstallPlan => {
  const unavailable: UninstallPlan = { kind: "unavailable" }
  if (!host.packaged || host.portable) return unavailable
  const dataFolders = host.userData === host.defaultUserData ? [host.userData] : []
  switch (host.platform) {
    case "linux": {
      const image = host.env.APPIMAGE
      if (!image) return unavailable
      const running = host.realpath(image)
      if (caskroomed(running)) return { kind: "manual", command: brewUninstallCommand }
      const layout = installLayout(host)
      if (running === undefined || running !== host.realpath(layout.image)) return unavailable
      return {
        kind: "linux",
        layout,
        folder: posix.dirname(layout.image),
        profile: host.uid === undefined ? undefined : apparmorProfile(host.uid),
        dataFolders,
      }
    }
    case "darwin": {
      const bundle = bundleOf(host.execPath)
      const installed = [`/Applications`, `${host.home}/Applications`].includes(
        posix.dirname(bundle),
      )
      const brewed =
        caskroomed(host.realpath(bundle)) ||
        caskroomPrefixes.some((prefix) => host.exists(`${prefix}/Caskroom/novadeck`))
      if (installed && brewed) return { kind: "manual", command: brewUninstallCommand }
      if (!installed || !bundle.endsWith(".app")) return unavailable
      return { kind: "mac", bundle, dataFolders }
    }
    case "win32": {
      // The installer writes `Uninstall <executable name>.exe` beside the executable
      // (`UNINSTALL_FILENAME` in electron-builder's `common.nsh`), which the unpacked ZIP
      // lacks. Only an uninstaller that is there can remove the app.
      const { dir, name } = win32.parse(host.execPath)
      const uninstaller = win32.join(dir, `Uninstall ${name}.exe`)
      return host.exists(uninstaller) ? { kind: "windows", uninstaller, dataFolders } : unavailable
    }
    default:
      return unavailable
  }
}

const isTarget = (found: Target | UninstallPlan): found is Target =>
  found.kind === "linux" || found.kind === "mac" || found.kind === "windows"

/** What uninstalling this copy would do; see `UninstallPlan`. */
export const uninstallPlan = (host: UninstallHost): UninstallPlan => {
  const found = identify(host)
  if (!isTarget(found)) return found
  return {
    kind: "ready",
    dataFolders: found.dataFolders,
    handoff: found.kind === "windows" ? "uninstaller" : "app",
  }
}

// eslint-disable-next-line no-control-regex -- These are the characters it refuses.
const controls = /[\x00-\x1f\x7f-\x9f]/u

/**
 * Whether `path` is exactly the absolute, normalized path of something this feature may
 * delete: no `..` or `.` segments, no doubled or trailing separators, no control
 * characters, not a root, and neither the home folder nor a folder that holds it.
 */
export const isRemovable = (
  path: string,
  { platform, home }: { readonly platform: NodeJS.Platform; readonly home: string },
): boolean => {
  const flavor = platform === "win32" ? win32 : posix
  if (controls.test(path) || !flavor.isAbsolute(path) || flavor.normalize(path) !== path)
    return false
  if (/[\\/]$/u.test(path) || flavor.parse(path).root === path) return false
  const folded = (value: string): string => (platform === "linux" ? value : value.toLowerCase())
  const [target, root] = [folded(path), folded(home).replace(/[\\/]+$/u, "")]
  return target !== root && !root.startsWith(`${target}${flavor.sep}`)
}

// The paths an uninstall would delete or trash, all of which must pass `isRemovable`.
const pathsOf = (target: Target, keepData: boolean): string[] => {
  const data = keepData ? [] : [...target.dataFolders]
  switch (target.kind) {
    case "linux": {
      const { image, link, desktop, icon } = target.layout
      return [...data, image, link, desktop, icon, target.folder]
    }
    case "mac":
      return [...data, target.bundle]
    case "windows":
      return data
  }
}

const failed = (reason: string): UninstallResult => ({ kind: "failed", reason })

const reasonOf = (error: unknown, general: string): string =>
  (error instanceof Error ? reasonText(error.message) : "") || general

const stoppedAdvice = "Novadeck has stopped your terminals; quit it and open it again."

const macTrashReason =
  "Novadeck could not be moved to the Trash. Allow it in System Settings > Privacy & Security > App Management, and try again."

/** What the page asks of the uninstall: the plan, the removal itself, and a plain quit. */
export type Uninstaller = {
  readonly plan: () => UninstallPlan
  readonly uninstall: (options: { readonly keepData: boolean }) => Promise<UninstallResult>
  readonly quit: () => void
}

/**
 * Removes the app from this computer. `uninstall` first checks the plan is `ready` and that
 * every path it would delete is the expected, absolute one, so a refusal changes nothing
 * and does not even end the shells. It then runs the shutdown quitting runs, so pages save
 * and nothing holds `workspace.sqlite` open, and only then touches files. The order is
 * chosen so that a failure leaves what is left as launchable as possible:
 *
 * - Linux removes the person's data first when asked (a failure there leaves the app
 *   whole), the AppImage next, and its links, menu entry, icon and folder after, as those
 *   are of no use without it. The AppArmor profile needs root: it is removed through the
 *   system's authentication prompt, and when that is unavailable or declined the answer
 *   is still `removed`, with the command for the person as `leftover`.
 * - macOS moves the bundle to the Trash before even the shutdown, which can fail on a
 *   permission and can be undone, so a refusal leaves the running app as it was and a retry
 *   can work; data is deleted after the shutdown.
 * - Windows cannot delete the running executable, so the NSIS uninstaller is started
 *   detached and the app quits for it. The installer's default keeps the data in
 *   `%APPDATA%`, and `keepData: false` asks nothing of it: Chromium holds that folder open
 *   while this process runs, so a detached helper waits for the process to end and deletes
 *   it then. The helper starts only after the uninstaller did, so a failed start never
 *   leaves a helper that would delete the data of an app that still exists.
 *
 * A failure after the shutdown leaves a running app whose shells have ended; its reason
 * says to quit and reopen it, and later requests get that same answer. A second request
 * while one is under way, or after one succeeded, gets that answer.
 */
export const uninstaller = (host: UninstallHost): Uninstaller => {
  let under: Promise<UninstallResult> | undefined
  let done: UninstallResult | undefined
  // The failure of a step after the shutdown, which every later request is answered with.
  let broken: UninstallResult | undefined

  const linux = async (
    target: Extract<Target, { kind: "linux" }>,
    keepData: boolean,
  ): Promise<UninstallResult> => {
    const { image, link, desktop, icon } = target.layout
    if (!keepData)
      await Promise.all(
        target.dataFolders.map((folder) => host.remove(folder, { recursive: true })),
      )
    await host.remove(image, { recursive: false })
    // The command only if it points at the AppImage removed: another install's is not ours.
    const pointsAt = await host.linkTarget(link)
    if (pointsAt === image) await host.remove(link, { recursive: false })
    await host.remove(desktop, { recursive: false })
    await host.remove(icon, { recursive: false })
    await host.removeEmptyFolder(target.folder)
    const { profile } = target
    if (profile === undefined || !host.exists(profile)) return { kind: "removed" }
    const asked = await host.privileged(["sh", "-c", profileScript, "sh", profile])
    if (asked && !host.exists(profile)) return { kind: "removed" }
    return { kind: "removed", leftover: profileCommand(profile) }
  }

  // The move to the Trash is made before the shutdown: it can fail and can be undone, and
  // a refusal then leaves the app running as it was, so the person can try again.
  const macTrash = async (
    target: Extract<Target, { kind: "mac" }>,
  ): Promise<UninstallResult | undefined> => {
    try {
      await host.trash(target.bundle)
    } catch (error) {
      host.log("Moving the app to the Trash failed.", error)
      return failed(macTrashReason)
    }
    // What an interrupted install left beside it, which a later launch would restore.
    const folder = posix.dirname(target.bundle)
    const name = posix.basename(target.bundle)
    await Promise.all(
      [`.${name}.old`, `.${name}.new`].map((leftover) =>
        host
          .remove(posix.join(folder, leftover), { recursive: true })
          .catch((error: unknown) => host.log("A leftover of an install was not removed.", error)),
      ),
    )
    return undefined
  }

  const macData = async (
    target: Extract<Target, { kind: "mac" }>,
    keepData: boolean,
  ): Promise<UninstallResult> => {
    if (!keepData)
      await Promise.all(
        target.dataFolders.map((folder) => host.remove(folder, { recursive: true })),
      )
    return { kind: "removed" }
  }

  const windows = async (
    target: Extract<Target, { kind: "windows" }>,
    keepData: boolean,
  ): Promise<UninstallResult> => {
    if (!(await host.startUninstaller(target.uninstaller)))
      throw new Error(
        "Windows did not run the uninstaller. Uninstall Novadeck in Windows Settings.",
      )
    if (!keepData && !(await host.removeAfterExit(target.dataFolders, target.uninstaller)))
      host.log("The data folders will stay.", target.dataFolders)
    // The uninstaller waits for the app to end; quit once the answer has been given.
    setTimeout(host.quit, 250)
    return { kind: "uninstalling" }
  }

  const run = async (keepData: boolean): Promise<UninstallResult> => {
    const target = identify(host)
    if (!isTarget(target)) return failed("Novadeck can't be uninstalled from this copy.")
    const options = { platform: host.platform, home: host.home }
    if (!pathsOf(target, keepData).every((path) => isRemovable(path, options)))
      return failed("Novadeck is not where it is expected, so nothing was removed.")
    if (host.stopping()) return failed("Novadeck is quitting.")
    if (target.kind === "mac") {
      const refused = await macTrash(target)
      if (refused) return refused
    }
    await host.shutdown().catch((error: unknown) => host.log("Shutting down failed.", error))
    // From here on the shells are gone, so a failure leaves a running app that cannot be
    // used; the reason says so, and later requests get the same answer.
    const stopped = (reason: string): UninstallResult => {
      broken = failed(`${reason.replace(/[.!?]?$/u, ".")} ${stoppedAdvice}`)
      return broken
    }
    try {
      switch (target.kind) {
        case "linux":
          return await linux(target, keepData)
        case "mac":
          return await macData(target, keepData)
        case "windows":
          return await windows(target, keepData)
      }
    } catch (error) {
      host.log("Uninstalling failed.", error)
      return stopped(reasonOf(error, "Something went wrong."))
    }
  }

  return {
    plan: () => uninstallPlan(host),
    uninstall: ({ keepData }) => {
      if (done ?? broken) return Promise.resolve((done ?? broken)!)
      under ??= run(keepData)
        .then((result) => {
          if (result.kind !== "failed") done = result
          return broken ?? result
        })
        .finally(() => {
          under = undefined
        })
      return under
    },
    quit: host.quit,
  }
}

// PowerShell's single-quoted string. PowerShell treats the typographic single quotes
// (U+2018 to U+201B) as quotes too, and a quote inside the string is written twice.
const quoted = (value: string): string => `'${value.replaceAll(/['\u2018-\u201b]/gu, "$&$&")}'`

// How long the helper waits for the uninstaller to finish: a person may take their time.
const uninstallerWaitMinutes = 10

/**
 * The PowerShell that waits for process `pid` to end, then waits (for up to ten minutes)
 * until the `setup` file (the uninstaller) is gone, which the NSIS uninstaller deletes as its last
 * step, and only then deletes `folders`, trying a few times as Chromium's helper processes
 * may outlive the main one by a moment. An uninstaller that was cancelled or failed leaves
 * its file, so nothing is deleted. The paths must have passed `isRemovable`.
 */
export const removalScript = (pid: number, folders: readonly string[], setup: string): string => {
  const list = folders.map(quoted).join(",")
  const file = quoted(setup)
  return (
    `Wait-Process -Id ${Math.trunc(pid)} -ErrorAction SilentlyContinue; ` +
    `$end = (Get-Date).AddMinutes(${uninstallerWaitMinutes}); ` +
    `while ((Test-Path -LiteralPath ${file}) -and (Get-Date) -lt $end) { Start-Sleep -Seconds 2 }; ` +
    `if (Test-Path -LiteralPath ${file}) { exit }; ` +
    `foreach ($folder in @(${list})) { ` +
    `for ($try = 0; $try -lt 20 -and (Test-Path -LiteralPath $folder); $try++) { ` +
    `Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue; ` +
    `if (Test-Path -LiteralPath $folder) { Start-Sleep -Seconds 1 } } }`
  )
}

/**
 * Starts the detached PowerShell helper that deletes `folders` after this process ended
 * and the `uninstaller` finished.
 * Resolves true once it started, false, having logged why, when it did not.
 */
export const startRemovalAfterExit = ({
  pid,
  folders,
  setup,
  spawn,
  log,
}: {
  readonly pid: number
  readonly folders: readonly string[]
  /** The uninstaller file, which is gone once the uninstall is done. */
  readonly setup: string
  readonly spawn: (
    file: string,
    args: readonly string[],
    options: {
      readonly detached: true
      readonly stdio: "ignore"
      readonly windowsHide: true
    },
  ) => StartedProcess
  readonly log: (message: string, error: unknown) => void
}): Promise<boolean> =>
  new Promise((resolve) => {
    try {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          removalScript(pid, folders, setup),
        ],
        { detached: true, stdio: "ignore", windowsHide: true },
      )
      child.once("error", (error) => {
        log("The helper that removes the data did not start.", error)
        resolve(false)
      })
      child.once("spawn", () => {
        child.unref()
        resolve(true)
      })
    } catch (error) {
      log("The helper that removes the data did not start.", error)
      resolve(false)
    }
  })

type UninstallIpc = {
  on(channel: string, listener: (event: IpcMainEvent) => void): unknown
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): unknown
}

/**
 * Answers the app's own pages what uninstalling would do, uninstalls for them and quits
 * on request. `window` names the window of a request from the main frame of the app's own
 * page, or undefined for any other sender, which is told it is `unavailable`, may not
 * uninstall, and is ignored when it asks to quit. Only a `keepData` of `false` deletes
 * data; anything else keeps it.
 */
export const registerUninstallIpc = <Window>(
  ipc: UninstallIpc,
  {
    window,
    uninstaller: current,
  }: {
    readonly window: (event: IpcMainEvent | IpcMainInvokeEvent) => Window | undefined
    readonly uninstaller: Uninstaller
  },
): void => {
  ipc.handle(uninstallPlanChannel, (event): UninstallPlan =>
    window(event) === undefined ? { kind: "unavailable" } : current.plan(),
  )
  ipc.handle(
    uninstallAppChannel,
    (event, options: unknown): Promise<UninstallResult> | UninstallResult => {
      if (window(event) === undefined) return failed("Uninstalling is not allowed from here.")
      const keepData =
        typeof options !== "object" ||
        options === null ||
        (options as { keepData?: unknown }).keepData !== false
      return current.uninstall({ keepData })
    },
  )
  ipc.on(quitAppChannel, (event) => {
    if (window(event) !== undefined) current.quit()
  })
}
