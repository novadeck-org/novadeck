import { createHash } from "node:crypto"
import { win32 } from "node:path"

import { updateVersionPattern } from "@novadeck/protocol/bridge"

import { isNewerVersion } from "./applications-folder.js"
import type { InstalledCopy } from "./install-linux.js"
import type { StartedProcess } from "./portable.js"

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
export const registryKeys = (appId: string): { location: string; version: string } => {
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

// The value of the top-level or listed `key:` on a line of latest.yml, unquoted.
const yamlValue = (line: string, key: string): string | undefined => {
  const match = new RegExp(`^\\s*(?:-\\s+)?${key}:[ \\t]*(.*?)[ \\t]*$`, "u").exec(line)
  return match?.[1]?.replace(/^(["'])(.*)\1$/u, "$2")
}

/** The release `version` that `latest.yml` names, if it names a plausible one. */
export const latestVersionOf = (yaml: string): string | undefined => {
  for (const line of yaml.split(/\r?\n/u)) {
    if (/^\s/u.test(line)) continue
    const version = yamlValue(line, "version")
    if (version !== undefined) return updateVersionPattern.test(version) ? version : undefined
  }
  return undefined
}

/**
 * The `sha512` (base64) that `latest.yml` lists for the file `name`: its `files` entry, or
 * the top-level `path` and `sha512` electron-builder repeats from the first. Undefined if
 * the file is not listed or has no hash.
 */
export const sha512Of = (yaml: string, name: string): string | undefined => {
  let url: string | undefined
  let hash: string | undefined
  const entries: { url: string | undefined; hash: string | undefined }[] = []
  let top: { path: string | undefined; hash: string | undefined } = {
    path: undefined,
    hash: undefined,
  }
  for (const line of yaml.split(/\r?\n/u)) {
    if (/^\s*-\s/u.test(line)) {
      if (url !== undefined || hash !== undefined) entries.push({ url, hash })
      url = undefined
      hash = undefined
    }
    if (/^\s/u.test(line)) {
      url = yamlValue(line, "url") ?? url
      hash = yamlValue(line, "sha512") ?? hash
    } else {
      top = {
        path: yamlValue(line, "path") ?? top.path,
        hash: yamlValue(line, "sha512") ?? top.hash,
      }
    }
  }
  if (url !== undefined || hash !== undefined) entries.push({ url, hash })
  const listed = entries.find((entry) => entry.url === name)
  if (listed) return listed.hash || undefined
  return top.path === name ? top.hash || undefined : undefined
}

/** How getting the setup ready went: the file, or why not. */
export type SetupOutcome =
  | { readonly kind: "ready"; readonly setup: string }
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
   * was written; throws on any failure, and gives up past `maxBytes`.
   */
  readonly download: (
    url: string,
    maxBytes: number,
  ) => Promise<{ readonly file: string; readonly sha512: string }>
  readonly remove: (file: string) => Promise<void>
  readonly log: (message: string, error: unknown) => void
}

/**
 * Downloads the latest release's setup and checks it against `latest.yml` from the same
 * release, all while the app runs normally, so a failure changes nothing. The setup is
 * ready only if `latest.yml` lists it with a SHA-512 and the file matches; a mismatch
 * removes the file. A latest release older than this copy is not installed, as that would
 * put an app that cannot open the workspace this one may have upgraded (an `early` copy
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
    downloaded = await host.download(`${base}${setupName}`, maxSetupBytes)
  } catch (error) {
    host.log("The installer could not be downloaded.", error)
    return { kind: "failed", reason: "The installer could not be downloaded. Are you online?" }
  }
  if (downloaded.sha512 !== expected) {
    await host.remove(downloaded.file).catch(() => {})
    return {
      kind: "failed",
      reason: "The downloaded installer did not match the release, so it was discarded.",
    }
  }
  return { kind: "ready", setup: downloaded.file }
}

/** The part of a response that downloading uses. */
export type DownloadResponse = {
  readonly ok: boolean
  readonly status: number
  readonly body: AsyncIterable<Uint8Array> | null
}

/**
 * Streams a response's body into `write`, hashing it on the way, and stops past `maxBytes`.
 * Returns the base64 SHA-512 of the body.
 */
export const hashBody = async (
  response: DownloadResponse,
  write: (chunk: Uint8Array) => Promise<void>,
  maxBytes: number,
): Promise<string> => {
  if (!response.ok || response.body === null)
    throw new Error(`The download answered ${response.status}.`)
  const hash = createHash("sha512")
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.byteLength
    if (total > maxBytes) throw new Error("The download is larger than expected.")
    hash.update(chunk)
    await write(chunk)
  }
  return hash.digest("base64")
}

/**
 * Starts `file` with `args` as a detached child and ends this process, the way
 * both the setup and an installed copy are started. The single-instance lock is let go
 * first so the program started can take it; this process has shut down by now. Never
 * through the shell, which would run it past SmartScreen and Mark of the Web (the file
 * this app wrote has none). Resolves true after `exit`, or false, having logged why, when
 * the file is missing or the system refused to start it, as an application control policy
 * (Smart App Control) does.
 */
export const startDetached = ({
  file,
  args = [],
  cwd,
  spawn,
  exists,
  releaseLock,
  exit,
  log,
}: {
  readonly file: string
  readonly args?: readonly string[]
  readonly cwd?: string | undefined
  readonly spawn: (
    file: string,
    args: readonly string[],
    options: {
      readonly detached: true
      readonly stdio: "ignore"
      readonly cwd?: string
    },
  ) => StartedProcess
  readonly exists: (path: string) => boolean
  readonly releaseLock: () => void
  readonly exit: () => void
  readonly log: (message: string, error: unknown) => void
}): Promise<boolean> =>
  new Promise((resolve) => {
    if (!exists(file)) {
      log("There is no program to start.", file)
      return resolve(false)
    }
    releaseLock()
    try {
      const child = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        ...(cwd === undefined ? {} : { cwd }),
      })
      child.once("error", (error) => {
        log("The program did not start.", error)
        resolve(false)
      })
      child.once("spawn", () => {
        child.unref()
        exit()
        resolve(true)
      })
    } catch (error) {
      log("The program did not start.", error)
      resolve(false)
    }
  })

/** The arguments the setup is run with: silently, and starting the installed app after. */
export const setupArguments = ["/S", "--force-run"] as const
