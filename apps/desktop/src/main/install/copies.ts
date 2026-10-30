// The copies of the app on this machine, as the running one meets them: where the installed
// ones are, installing one from this copy, starting one in this copy's place, and removing
// this one. The rules live beside it, in ./linux.ts, ./mac.ts, ./windows.ts and ./uninstall.ts;
// this is where they are handed the system.
import { execFile, spawn } from "node:child_process"
import { accessSync, existsSync, realpathSync } from "node:fs"
import {
  access,
  chmod,
  constants,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
} from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, win32 } from "node:path"

import { app, dialog, net, shell } from "electron"

import { dataFolderName } from "../data-folder.js"
import type { InstallStep, PlatformInstall } from "../portable/installer.js"
import { prepareAppImage } from "../releases/appimage.js"
import {
  portableAssets,
  sha512Base64,
  streamToFile,
  type Digest,
  type Download,
  type Fetched,
} from "../releases/download.js"
import { releaseDownloadsUrl, releaseLatestUrl } from "../releases/repository.js"
import { releaseRepository } from "../resources.js"
import {
  extractWithProcess,
  failureReason,
  findInstalled,
  installAppImage,
  installLayout,
} from "./linux.js"
import {
  bundleOf,
  bundleVersionOf,
  findInstalledApps,
  installBundle,
  recoverBundles,
  relaunchIntoCopy,
} from "./mac.js"
import { installedEnvironment, startAppImage, startDetached } from "./start.js"
import { startRemovalAfterExit, uninstaller, type Uninstaller } from "./uninstall.js"
import {
  findInstalledWindows,
  insideInstallFolder,
  installedAtLeast,
  installedByInstaller,
  legacyPrefixFolder,
  powershellUsable,
  prepareSetup,
  readInstallRecord,
  readLegacyUninstaller,
  runSetup,
  SetupBusyError,
  setupName,
  setupResult,
  type InstallRecord,
} from "./windows.js"

/** The canonical form of a path, or undefined when it cannot be had. */
export const realpathOrUndefined = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** The folder this copy's AppImage is mounted at, as the runtime names it and as it resolves. */
export const appImageMounts = (): string[] => {
  const mount = process.env.APPDIR
  return mount ? [mount, realpathOrUndefined(mount) ?? mount] : []
}

/** Whether the folder holding the AppImage file can be written to, as replacing it takes. */
export const appImageWritable = (): Promise<boolean> => {
  const file = process.env.APPIMAGE
  return file
    ? access(dirname(file), constants.W_OK).then(
        () => true,
        () => false,
      )
    : Promise.resolve(false)
}

/**
 * Where the Windows setup is downloaded to: one folder in the user's temporary folder,
 * emptied before each download, so no more than one setup is ever kept.
 */
export const setupFolder = (): string => join(app.getPath("temp"), "novadeck-setup")

// The folder the Windows installer puts the app in unless told otherwise.
const defaultInstallFolder = (): string | undefined =>
  process.env.LOCALAPPDATA
    ? win32.join(process.env.LOCALAPPDATA, "Programs", "novadeck")
    : undefined

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

// Runs a system tool, rejecting with its error, including what it wrote to stderr.
const runTool = (file: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 300_000 }, (error, _stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(),
    )
  })

// Whether `path` is there.
const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

// Whether the person can write to `path`.
const canWrite = (path: string): Promise<boolean> =>
  access(path, constants.W_OK).then(
    () => true,
    () => false,
  )

// The text of `url`, fetched with a time limit; undefined for a 404, and a throw for
// anything else but 200.
const fetchText = async (url: string): Promise<string | undefined> => {
  const response = await net.fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`)
  return response.text()
}

// Streams `url` into `file` through Electron's network stack, which honours the system and
// PAC proxies as the update check does, hashing as it goes; see `streamToFile`. The file is
// written by this app, so it carries no Mark of the Web; the hash is what vouches for it.
const downloadTo = (
  url: string,
  file: string,
  maxBytes: number,
  progress: (percent: number) => void,
  digest: Digest,
  size?: number,
): Promise<string> =>
  streamToFile({
    url,
    file,
    maxBytes,
    size,
    digest,
    progress,
    fetch: async (address, init) => (await net.fetch(address, init)) as unknown as Fetched,
    open: (path) => open(path, "w"),
    remove: (path) => rm(path, { force: true }),
  })

// Downloads `url` into the setup folder, emptied first; see `downloadTo`.
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
  const sha512 = await downloadTo(url, file, maxBytes, progress, sha512Base64, size)
  return { file, sha512 }
}

// A SHA-256 download of a portable file; see `Download`.
const downloadPortable: Download = (url, file, maxBytes, progress) =>
  downloadTo(url, file, maxBytes, progress, { algorithm: "sha256", encoding: "hex" })

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

// The bundle names an installed copy may have: the running one's, and the packaged name,
// which is the executable's (`executableName` in electron-builder.yml) and survives a
// rename of the bundle.
const installedNames = (): string[] => [
  basename(bundleOf(app.getPath("exe"))),
  `${basename(app.getPath("exe"))}.app`,
]

// The macOS install: this bundle copied into Applications while the app keeps running; see
// `installBundle`.
const bundleMachine = (log: (message: string, error: unknown) => void) => ({
  packaged: `${basename(app.getPath("exe"))}.app`,
  applications: "/Applications",
  userApplications: join(homedir(), "Applications"),
  exists,
  rename,
  remove: (path: string) => rm(path, { recursive: true, force: true }),
  log,
})

// Reads the versions of installed AppImages with the environment they are started with.
const installedExtract = () =>
  extractWithProcess(installedEnvironment(process.env, appImageMounts()))

/** What the copies are handed of the running app. */
export type CopiesHost = {
  /** The Windows installer's id for the app, which its registry record is kept under. */
  readonly appId: string
  /** Ends this process, its log closed first. */
  readonly exitApp: (code: number) => void
  /** The version the app's last update offer named as available, if it did. */
  readonly offered: () => string | undefined
  readonly log: (message: string, error: unknown) => void
}

/** The copies of the app on this machine, as the running copy finds, installs and starts them. */
export const machineCopies = ({ appId, exitApp, offered, log }: CopiesHost) => {
  // What the Windows installer recorded of an installed copy; see `readInstallRecord`.
  const installRecord = (): Promise<InstallRecord> => readInstallRecord(appId, queryRegistry)

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

  // The copies of the app installed on this machine, with their versions.
  const installedCopies = () =>
    process.platform === "win32"
      ? findInstalledWindows({
          defaultFolder: defaultInstallFolder(),
          executable: basename(process.execPath),
          record: installRecord,
          exists,
        })
      : process.platform === "darwin"
        ? findInstalledApps({
            folders: ["/Applications", join(homedir(), "Applications")],
            names: installedNames(),
            exists,
            readFile: (path) => readFile(path, "utf8"),
          })
        : findInstalled({ env: process.env, home: homedir() }, installedExtract())

  // Starts the macOS app bundle `image` in place of this one; see `relaunchIntoCopy`. Nothing
  // has to be let go first: the relaunch happens as this process ends.
  const startBundle = (image: string): Promise<boolean> =>
    Promise.resolve(
      relaunchIntoCopy({
        executable: join(image, "Contents", "MacOS", basename(app.getPath("exe"))),
        exists: existsSync,
        relaunch: (execPath) => app.relaunch({ execPath }),
        exit: () => exitApp(0),
        log,
      }),
    )

  // Starts the AppImage at `image` in place of this process, once the process `after`
  // names has gone; see `startAppImage`.
  const startInstalledImage = (image: string, after?: number): Promise<boolean> =>
    startAppImage({
      image,
      after,
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
      log,
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
      log,
    })

  // The macOS install; see `bundleMachine`.
  const installMacBundle = async (
    target: string | undefined,
    progress: (step: InstallStep) => void,
  ): Promise<PlatformInstall> => {
    progress({ phase: "installing" })
    return installBundle(target, {
      ...bundleMachine(log),
      running: bundleOf(app.getPath("exe")),
      version: app.getVersion(),
      versionOf: (path) =>
        readFile(join(path, "Contents", "Info.plist"), "utf8").then(
          bundleVersionOf,
          () => undefined,
        ),
      writable: canWrite,
      mkdir: async (folder) => void (await mkdir(folder, { recursive: true })),
      ditto: (source, destination) => runTool("/usr/bin/ditto", [source, destination]),
      unquarantine: (path) => runTool("/usr/bin/xattr", ["-dr", "com.apple.quarantine", path]),
    })
  }

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
      log,
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
      log,
    })
    const installed =
      ran === "failed"
        ? undefined
        : installedAtLeast(await installedCopies().catch(() => []), outcome.version)
    // A setup still running at the timeout holds its folder; the next try says so.
    if (ran !== "timeout") await rm(setupFolder(), { recursive: true, force: true }).catch(() => {})
    return setupResult(ran, installed)
  }

  // Installs the release's AppImage, the offered version's or the latest, over the installed
  // copy `target` or at the installer's path; see `prepareAppImage`. This copy is not what is
  // installed: it is older than the release the card advertised.
  const installAppImageOver = async (
    target: string | undefined,
    progress: (step: InstallStep) => void,
  ): Promise<PlatformInstall> => {
    progress({ phase: "installing" })
    // A private folder of its own, so a leftover of another user's or another run's cannot
    // be in the way, and it is gone afterwards.
    let folder = app.getPath("temp")
    try {
      folder = await mkdtemp(join(app.getPath("temp"), "novadeck-install-"))
      const repository = await releaseRepository()
      const version = offered()
      const prepared = await prepareAppImage(
        {
          downloads: {
            offered:
              repository && version !== undefined
                ? releaseDownloadsUrl(repository, version)
                : undefined,
            latest: repository && releaseLatestUrl(repository),
            own: repository && releaseDownloadsUrl(repository, app.getVersion()),
          },
          version: app.getVersion(),
          text: fetchText,
          download: downloadPortable,
          remove: (file) => rm(file, { force: true }),
          makeExecutable: (file) => chmod(file, 0o755),
          progress: (percent) => progress({ phase: "downloading", percent }),
          log,
        },
        join(folder, portableAssets.linux),
      )
      if (prepared.kind === "failed") return prepared
      progress({ phase: "installing" })
      return await installAppImage(
        prepared.file,
        installLayout({ env: process.env, home: homedir() }),
        installedExtract(),
        target,
      )
    } catch (error) {
      log("The AppImage could not be installed.", error)
      return { kind: "failed", reason: failureReason(error, folder) }
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => {})
    }
  }

  return {
    windowsInstalled,
    installedCopies,
    startInstalledImage,

    /**
     * Tidies what an install interrupted on macOS may have left: the only installed copy
     * renamed aside, and a half-made one.
     */
    recoverBundles: () =>
      recoverBundles({ ...bundleMachine(log), names: installedNames() }).catch(() => undefined),

    /** Starts the installed copy `image` in place of this one, the way this system does. */
    startInstalledCopy: (image: string): Promise<boolean> =>
      process.platform === "darwin"
        ? startBundle(image)
        : process.platform === "win32"
          ? startWindowsCopy(image)
          : startInstalledImage(image),

    startBundle,

    /** Installs the app from this copy, over the installed copy `target` if there is one. */
    install: (
      target: string | undefined,
      progress: (step: InstallStep) => void,
    ): Promise<PlatformInstall> =>
      process.platform === "darwin"
        ? installMacBundle(target, progress)
        : process.platform === "win32"
          ? installWindowsSetup(progress)
          : installAppImageOver(target, progress),

    /**
     * Tells the person that the installed copy at `image` would not start, which leaves the
     * app with nothing to do but quit.
     */
    alertNotStarted: async (image: string): Promise<void> => {
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
    },
  }
}

/** The copies of the app on this machine; see `machineCopies`. */
export type MachineCopies = ReturnType<typeof machineCopies>

/** What removing this copy asks of the running app. */
export type MachineUninstallHost = {
  readonly portable: boolean
  /** Quits as usual, less the install of a waiting update, which would put the app back. */
  readonly shutdown: () => Promise<void>
  readonly stopping: () => boolean
  readonly log: (message: string, error: unknown) => void
}

/** What removing this copy does, handed the system; see `uninstaller`. */
export const machineUninstaller = ({
  portable,
  shutdown,
  stopping,
  log,
}: MachineUninstallHost): Uninstaller =>
  uninstaller({
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
        log,
      }),
    removeAfterExit: (folders, uninstallerFile) =>
      startRemovalAfterExit({
        pid: process.pid,
        folders,
        setup: uninstallerFile,
        spawn,
        log,
      }),
    shutdown,
    stopping,
    quit: () => app.quit(),
    log,
  })
