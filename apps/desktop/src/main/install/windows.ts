import { createHash } from "node:crypto"
import { win32 } from "node:path"

import { updateVersionPattern } from "@novadeck/protocol/bridge"

import { latestVersionOf, sha512Of, sizeOf } from "../releases/latest-yml.js"
import { isNewerVersion } from "../releases/versions.js"
import type { InstalledCopy } from "./linux.js"

/** The setup file a release carries, and the name `latest.yml` lists it under. */
export const setupName = "novadeck-win-x64-setup.exe"

// The most bytes the setup may be; the release's is about a hundred megabytes.
const maxSetupBytes = 1 << 30

// electron-builder's namespace for the GUID it derives from the app id.
const builderNamespace = "50e065bc-3134-11e6-9bab-38c9862bdaf3"

/** The name-based (version 5) UUID of `name` in `namespace`, as RFC 9562 defines it. */
export const uuidV5 = (name: string, namespace: string): string => {
  const hash = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name)
    .digest()
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString("hex")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-")
}

/**
 * The GUID the installer files itself under, which electron-builder derives from the app
 * id (`nsis.guid` is unset). It names both registry keys the installer writes.
 */
export const installerGuid = (appId: string): string => uuidV5(appId, builderNamespace)

/** The registry keys of an installed copy, read for `InstallLocation` and `DisplayVersion`. */
const registryKeys = (appId: string): { location: string; version: string } => {
  const guid = installerGuid(appId)
  return {
    location: `HKCU\\Software\\${guid}`,
    version: `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`,
  }
}

/** The data of the string value `name` in the output of `reg query <key> /v <name>`. */
export const registryValue = (output: string, name: string): string | undefined => {
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/u.exec(line)
    if (match?.[1]?.toLowerCase() === name.toLowerCase() && match[2] !== "") return match[2]
  }
  return undefined
}

/**
 * What the installer recorded for an installed copy: where it is and its version, each
 * undefined when the key or value is absent. A `run` that throws says the registry could
 * not be read; `run` answers "" for a key that is not there.
 */
export type InstallRecord = {
  readonly location: string | undefined
  readonly version: string | undefined
}

export const readInstallRecord = async (
  appId: string,
  run: (key: string, name: string) => Promise<string>,
): Promise<InstallRecord> => {
  const keys = registryKeys(appId)
  const [location, version] = await Promise.all([
    run(keys.location, "InstallLocation"),
    run(keys.version, "DisplayVersion"),
  ])
  return {
    location: registryValue(location, "InstallLocation"),
    version: registryValue(version, "DisplayVersion"),
  }
}

// A folder as it compares: Windows paths ignore case and a trailing separator.
const folderKey = (folder: string): string =>
  win32
    .normalize(folder)
    .replace(/[\\/]+$/u, "")
    .toLowerCase()

/**
 * The folder of `folders` that the executable `execPath` is in or under, whole path
 * segments only, or undefined if none. The setup replaces everything in the install
 * folder and its running-app check refuses to run while Novadeck runs from there, so a
 * copy unpacked into it can't install.
 */
export const insideInstallFolder = (
  execPath: string,
  folders: readonly (string | undefined)[],
): string | undefined => {
  const here = win32.normalize(execPath).toLowerCase()
  return folders.find((folder): folder is string => {
    if (folder === undefined || folder === "") return false
    const key = folderKey(folder)
    return here.startsWith(`${key}\\`)
  })
}

/** The value `resources/installer.nsh` writes beside builder's `InstallLocation` of every install. */
export const runningCheckValue = "RunningCheck"

/**
 * LEGACY. Whether the installed copy the registry records may carry builder's old
 * running-app check in its uninstaller, which a new setup runs first
 * (`uninstallOldVersion` in electron-builder's `installUtil.nsh`, `/S --updated`): there is
 * a record of an install (an `UninstallString` or an `InstallLocation`, whether or not its
 * executable is still there) without the `RunningCheck` marker of an install made by this
 * installer. A registry that cannot be read counts as legacy, the safe answer.
 */
export const readLegacyUninstaller = async (
  appId: string,
  run: (key: string, name: string) => Promise<string>,
): Promise<boolean> => {
  const keys = registryKeys(appId)
  try {
    const [uninstall, location, marker] = await Promise.all([
      run(keys.version, "UninstallString"),
      run(keys.location, "InstallLocation"),
      run(keys.location, runningCheckValue),
    ])
    const recorded =
      registryValue(uninstall, "UninstallString") !== undefined ||
      registryValue(location, "InstallLocation") !== undefined
    return recorded && registryValue(marker, runningCheckValue) === undefined
  } catch {
    return true
  }
}

/**
 * LEGACY. The folder of `folders` whose name `execPath` merely starts with, a sibling such
 * as `novadeck-portable` included. The old uninstaller's PowerShell path stops every
 * process with `StartsWith($INSTDIR, CurrentCultureIgnoreCase)`, with no separator after it.
 */
export const legacyPrefixFolder = (
  execPath: string,
  folders: readonly (string | undefined)[],
): string | undefined => {
  const here = win32.normalize(execPath).toLowerCase()
  return folders.find(
    (folder): folder is string =>
      folder !== undefined && folder !== "" && here.startsWith(folderKey(folder)),
  )
}

/**
 * LEGACY. The two PowerShell commands electron-builder's `IS_POWERSHELL_AVAILABLE` runs
 * (see `allowOnlyOneInstallerInstance.nsh`), each answering by exit code 0 for yes. The old
 * uninstaller stops only processes inside the install folder where both say yes, and
 * otherwise every process named `novadeck.exe`, which would stop a portable copy.
 */
export const powershellChecks = [
  "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }",
  "if ((Get-ExecutionPolicy -Scope Process) -eq 'Restricted') { exit 1 } else { exit 0 }",
] as const

/** LEGACY. Whether both `powershellChecks` pass, each asked by `run` as `powershell.exe -C <command>`. */
export const powershellUsable = async (
  run: (command: string) => Promise<boolean>,
): Promise<boolean> => {
  for (const command of powershellChecks) if (!(await run(command))) return false
  return true
}

/**
 * Whether the running executable is a copy the installer made, as opposed to the unpacked
 * ZIP, which carries nothing of the installer. The NSIS installer writes
 * `Uninstall <executable name>.exe` beside the executable (`UNINSTALL_FILENAME` in
 * electron-builder's `common.nsh`), which the ZIP lacks. That alone could miss an
 * installed copy whose uninstaller was deleted, so a copy in the folder the installer
 * recorded, or in its default place, counts as installed too. A false "installed" only
 * keeps the copy from offering to install, which a stray ZIP unpacked into the installer's
 * own folder deserves; a false "portable" would offer to overwrite an install.
 */
export const installedByInstaller = ({
  execPath,
  recorded,
  defaultFolder,
  exists,
}: {
  readonly execPath: string
  /** The `InstallLocation` the installer recorded, when it could be read. */
  readonly recorded: string | undefined
  readonly defaultFolder: string | undefined
  readonly exists: (path: string) => boolean
}): boolean => {
  const { dir, name } = win32.parse(execPath)
  if (exists(win32.join(dir, `Uninstall ${name}.exe`))) return true
  const here = folderKey(dir)
  return [recorded, defaultFolder].some(
    (folder) => folder !== undefined && folder !== "" && folderKey(folder) === here,
  )
}

/** What finding installed copies on Windows looks at of the machine. */
export type InstalledWindowsHost = {
  /** The folder the installer puts the app in unless told otherwise; undefined if unknown. */
  readonly defaultFolder: string | undefined
  /** The installed executable's file name, `novadeck.exe`. */
  readonly executable: string
  /** The installer's record; throws when the registry could not be read. */
  readonly record: () => Promise<InstallRecord>
  readonly exists: (path: string) => Promise<boolean>
}

/**
 * The installed copies of the app: the folder the installer recorded and its default one,
 * each once and only when its executable is there. The version is the installer's record,
 * trusted only for the folder it names; a copy without a readable record might be a newer
 * app, so it is `unchecked` and never replaced.
 */
export const findInstalledWindows = async ({
  defaultFolder,
  executable,
  record,
  exists,
}: InstalledWindowsHost): Promise<InstalledCopy[]> => {
  let recorded: InstallRecord | undefined
  try {
    recorded = await record()
  } catch {
    recorded = undefined
  }
  const folders = [recorded?.location, defaultFolder].filter(
    (folder): folder is string => folder !== undefined && folder !== "",
  )
  // reg.exe writes the OEM code page, so a profile path with letters outside ASCII reaches
  // here garbled, and the recorded folder then holds no executable. `DisplayVersion` is
  // ASCII, and the default folder comes from the environment: it is the recorded copy.
  const recordedThere =
    recorded?.location === undefined || (await exists(win32.join(recorded.location, executable)))
  const unique = folders.filter(
    (folder, index) =>
      folders.findIndex((other) => folderKey(other) === folderKey(folder)) === index,
  )
  const copies = await Promise.all(
    unique.map(async (folder): Promise<InstalledCopy | undefined> => {
      const image = win32.join(folder, executable)
      if (!(await exists(image))) return undefined
      const own =
        recorded?.location !== undefined &&
        (folderKey(recorded.location) === folderKey(folder) ||
          (!recordedThere &&
            defaultFolder !== undefined &&
            folderKey(defaultFolder) === folderKey(folder)))
      const version = own ? recorded?.version : undefined
      const known = version !== undefined && updateVersionPattern.test(version)
      return { image, version: known ? version : undefined, unchecked: !known }
    }),
  )
  return copies.filter((copy) => copy !== undefined)
}

/** What the person is told while an earlier setup is still running. */
export const setupRunningReason = "The installer is still running. Try again in a few minutes."

/**
 * Thrown by a download that cannot clear the setup folder because an earlier setup still
 * runs from it (its file is locked), which is no sign of a network problem.
 */
export class SetupBusyError extends Error {}

/**
 * What the install answers once the setup has run: `failed` when it never started, the
 * copy it left when one of the release's version or newer is there, and otherwise, for a
 * setup that was still running when the wait ended, a plain statement of that; a setup that
 * exited without leaving the copy did not finish.
 */
export const setupResult = (
  ran: SetupRun,
  installed: InstalledCopy | undefined,
):
  | { readonly kind: "installed"; readonly image: string }
  | { readonly kind: "failed"; readonly reason: string } => {
  if (ran === "failed")
    return {
      kind: "failed",
      reason: "Windows did not run the installer. Download Novadeck again from its Releases page.",
    }
  if (installed !== undefined) return { kind: "installed", image: installed.image }
  if (ran === "timeout") return { kind: "failed", reason: setupRunningReason }
  if (ran === "in-use")
    return {
      kind: "failed",
      reason:
        "Novadeck can't install while something from its install folder is still running. Quit Novadeck there, or restart Windows, then try again.",
    }
  return {
    kind: "failed",
    reason: "The installer did not finish installing Novadeck.",
  }
}

/** How getting the setup ready went: the file, or why not. */
export type SetupOutcome =
  | { readonly kind: "ready"; readonly setup: string; readonly version: string }
  | { readonly kind: "failed"; readonly reason: string }

/** What getting the setup uses of the machine and the network. */
export type SetupHost = {
  /**
   * The addresses, each ending in "/", that assets download from: the latest stable
   * release's, and this copy's own release's. Either is undefined where it cannot be named.
   */
  readonly downloads: {
    readonly latest: string | undefined
    readonly own: string | undefined
  }
  /** This build's version. */
  readonly version: string
  /**
   * The text of `url`, or undefined when it answers 404; throws on any other failure,
   * including a network error or a status other than 200.
   */
  readonly text: (url: string) => Promise<string | undefined>
  /**
   * Downloads `url` into a fresh file and gives its path and the base64 SHA-512 of what
   * was written; throws on any failure, and gives up past `maxBytes`. `size` is the
   * release's byte count for the file, when it lists one, which whole-percent `progress`
   * is measured against.
   */
  readonly download: (
    url: string,
    maxBytes: number,
    size: number | undefined,
    progress: (percent: number) => void,
  ) => Promise<{ readonly file: string; readonly sha512: string }>
  readonly remove: (file: string) => Promise<void>
  /** Told the whole percent downloaded, each as it changes. */
  readonly progress: (percent: number) => void
  readonly log: (message: string, error: unknown) => void
}

/**
 * Downloads the latest release's setup and checks it against `latest.yml` from the same
 * release, all while the app runs normally, so a failure changes nothing. The setup is
 * ready only if `latest.yml` lists it with a SHA-512 and the file matches; a mismatch
 * removes the file. A latest release older than this copy is not installed, as that would
 * put an app that cannot open the workspace this one may have upgraded (an `experimental` copy
 * newer than the latest stable release). While there is no stable release (`latest`
 * answers 404), and in that older case, it uses this copy's own release instead, fetching
 * both files from there; that one is by definition not older. The installed copy updates
 * itself from there only once a release on its channel is newer.
 */
export const prepareSetup = async (host: SetupHost): Promise<SetupOutcome> => {
  const { latest: latestBase, own } = host.downloads
  if (latestBase === undefined && own === undefined)
    return { kind: "failed", reason: "This copy does not know where Novadeck is released." }
  // The release to install from: `latest` unless it is missing or older than this copy,
  // then this copy's own, which is never older. A network failure is not a reason to guess
  // elsewhere.
  let found: { readonly base: string; readonly yaml: string } | undefined
  try {
    if (latestBase !== undefined) {
      const yaml = await host.text(`${latestBase}latest.yml`)
      const version = yaml === undefined ? undefined : latestVersionOf(yaml)
      if (yaml !== undefined && version !== undefined && isNewerVersion(host.version, version))
        host.log("The latest release is older than this copy.", version)
      else if (yaml !== undefined) found = { base: latestBase, yaml }
    }
    if (found === undefined && own !== undefined) {
      const yaml = await host.text(`${own}latest.yml`)
      if (yaml !== undefined) found = { base: own, yaml }
    }
  } catch (error) {
    host.log("The release information could not be fetched.", error)
    return { kind: "failed", reason: "The latest release could not be fetched. Are you online?" }
  }
  if (found === undefined)
    return { kind: "failed", reason: "No release with the Windows installer was found." }
  const { base, yaml } = found
  const expected = sha512Of(yaml, setupName)
  if (expected === undefined)
    return { kind: "failed", reason: "The release does not list the Windows installer." }
  let downloaded: { readonly file: string; readonly sha512: string }
  try {
    downloaded = await host.download(
      `${base}${setupName}`,
      maxSetupBytes,
      sizeOf(yaml, setupName),
      host.progress,
    )
  } catch (error) {
    host.log("The installer could not be downloaded.", error)
    if (error instanceof SetupBusyError) return { kind: "failed", reason: setupRunningReason }
    return { kind: "failed", reason: "The installer could not be downloaded. Are you online?" }
  }
  if (downloaded.sha512 !== expected) {
    await host.remove(downloaded.file).catch(() => {})
    return {
      kind: "failed",
      reason: "The downloaded installer did not match the release, so it was discarded.",
    }
  }
  return { kind: "ready", setup: downloaded.file, version: latestVersionOf(yaml) ?? host.version }
}

/**
 * The arguments the setup is run with: silently, and not starting the installed app after
 * (no `--force-run`), since this copy keeps running and nothing restarts by itself.
 */
export const setupArguments = ["/S"] as const

/** How running the setup ended: it exited (or, with `setupInUseExitCode`, found Novadeck running from the install folder), it was still running at `timeoutMs`, or never started. */
export type SetupRun = "exited" | "in-use" | "timeout" | "failed"

/** The exit code `resources/installer.nsh` ends the setup with when Novadeck runs from the install folder. */
export const setupInUseExitCode = 3

/** The part of a child process that waiting for the setup uses. */
export type SetupProcess = {
  once(event: "spawn", listener: () => void): unknown
  once(event: "exit", listener: (code: number | null) => void): unknown
  once(event: "error", listener: (error: Error) => void): unknown
  unref(): void
}

/**
 * Runs the setup `file` with `args` as a detached child and waits for it to exit, or for
 * `timeoutMs`, whichever is first; it is not killed at the timeout, as a setup stopped
 * halfway leaves a broken install. This process keeps running, holds its single-instance
 * lock, and never exits here. Never through the shell, which would run it past
 * SmartScreen and Mark of the Web (the file this app wrote has none). The caller checks
 * what the setup did: how it ended says little, as the setup may have started a helper
 * and returned.
 */
export const runSetup = ({
  file,
  args = setupArguments,
  spawn,
  exists,
  timeoutMs,
  log,
}: {
  readonly file: string
  readonly args?: readonly string[]
  readonly spawn: (
    file: string,
    args: readonly string[],
    options: { readonly detached: true; readonly stdio: "ignore"; readonly windowsHide: true },
  ) => SetupProcess
  readonly exists: (path: string) => boolean
  readonly timeoutMs: number
  readonly log: (message: string, error: unknown) => void
}): Promise<SetupRun> =>
  new Promise((resolve) => {
    if (!exists(file)) {
      log("There is no setup to run.", file)
      return resolve("failed")
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const end = (outcome: SetupRun): void => {
      clearTimeout(timer)
      resolve(outcome)
    }
    try {
      const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true })
      child.once("error", (error) => {
        log("The setup did not start.", error)
        end("failed")
      })
      child.once("spawn", () => {
        child.unref()
        timer = setTimeout(() => {
          log("The setup is still running.", file)
          end("timeout")
        }, timeoutMs)
      })
      child.once("exit", (code) => end(code === setupInUseExitCode ? "in-use" : "exited"))
    } catch (error) {
      log("The setup did not start.", error)
      end("failed")
    }
  })

/**
 * The installed copy of `version` or newer, whose executable is there: the only
 * proof that the setup did its work. The installer's own record names the version, so a
 * copy that cannot be checked does not count.
 */
export const installedAtLeast = (
  copies: readonly InstalledCopy[],
  version: string,
): InstalledCopy | undefined =>
  copies.find(
    ({ version: found }) =>
      found !== undefined && (found === version || isNewerVersion(found, version)),
  )
