import { execFile } from "node:child_process"
import { access, constants, mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { posix } from "node:path"

import { reasonText } from "./install-reason.js"

/**
 * How the running bundle can be replaced: the whole `.app`, or only its `Contents` where
 * the folder holding it (such as `/Applications`) is not the person's to write.
 */
export type MacSwapMode = "whole" | "contents"

/** What updating the app bundle asks of the machine. */
export type MacUpdateHost = {
  /** The temporary folder, which holds the prepared update and the old bundle aside. */
  readonly tmpdir: () => string
  /** The names in a folder. */
  readonly readdir: (folder: string) => Promise<string[]>
  readonly readFile: (path: string) => Promise<string>
  /** Makes a new folder named `prefix` and a random suffix, and returns its path. */
  readonly mkdtemp: (prefix: string) => Promise<string>
  readonly exists: (path: string) => Promise<boolean>
  /** When `path` last changed, in milliseconds since the epoch; 0 when that can't be had. */
  readonly modified: (path: string) => Promise<number>
  /** Whether the person can write to `path`, a file or a folder. */
  readonly writable: (path: string) => Promise<boolean>
  readonly rename: (from: string, to: string) => Promise<void>
  /** Removes a file or a folder with all it holds; a path that is not there is fine. */
  readonly remove: (path: string) => Promise<void>
  /** `ditto -x -k <zip> <folder>`. */
  readonly unzip: (zip: string, folder: string) => Promise<void>
  /** `ditto <source> <destination>`: copies a bundle whole, keeping what it carries. */
  readonly copy: (source: string, destination: string) => Promise<void>
  /** `xattr -dr com.apple.quarantine <path>`. */
  readonly unquarantine: (path: string) => Promise<void>
  /** `codesign --verify --deep --strict <bundle>`; rejects when the signature is not sound. */
  readonly codesignVerify: (bundle: string) => Promise<void>
  /** What `codesign -dv <bundle>` prints. */
  readonly codesignDetails: (bundle: string) => Promise<string>
  /** `osascript -e <script>`; rejects with the error text osascript printed. */
  readonly osascript: (script: string) => Promise<void>
}

const run = (file: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 300_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message))
      else resolve(`${stdout}${stderr}`)
    })
  })

/** Real host: `node:fs/promises`, `/usr/bin/ditto`, `codesign`, `xattr` and `osascript`, `os.tmpdir()`. */
export const macUpdateHost: MacUpdateHost = {
  tmpdir,
  readdir: (folder) => readdir(folder),
  readFile: (path) => readFile(path, "utf8"),
  mkdtemp: (prefix) => mkdtemp(prefix),
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  modified: (path) =>
    stat(path).then(
      ({ mtimeMs }) => mtimeMs,
      () => 0,
    ),
  writable: (path) =>
    access(path, constants.W_OK).then(
      () => true,
      () => false,
    ),
  rename,
  remove: (path) => rm(path, { recursive: true, force: true }),
  unzip: async (zip, folder) => void (await run("/usr/bin/ditto", ["-x", "-k", zip, folder])),
  copy: async (source, destination) => void (await run("/usr/bin/ditto", [source, destination])),
  unquarantine: async (path) =>
    void (await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", path])),
  codesignVerify: async (bundle) =>
    void (await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle])),
  codesignDetails: (bundle) => run("/usr/bin/codesign", ["-dv", bundle]),
  osascript: async (script) => void (await run("/usr/bin/osascript", ["-e", script])),
}

// A prepared update lives in a folder of this name under the temporary folder, which is how
// the next one finds it. The app's own identifier keeps it from other apps' folders.
const preparedPrefix = "dev.mzpk.novadeck.update-"

/**
 * How the running bundle can be replaced. `whole` where the bundle and the folder holding
 * it can both be written, `contents` where only the bundle and its `Contents` can be (a
 * copy the person dragged into a folder they do not own), nothing where neither.
 */
export const macSwapMode = async (
  bundle: string,
  host: MacUpdateHost = macUpdateHost,
): Promise<MacSwapMode | undefined> => {
  if (!(await host.writable(bundle))) return undefined
  if (await host.writable(posix.dirname(bundle))) return "whole"
  if (await host.writable(posix.join(bundle, "Contents"))) return "contents"
  return undefined
}

// A string key of an XML `Info.plist`, if it has one.
const plistString = (plist: string, key: string): string | undefined =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]{1,200})</string>`, "u").exec(plist)?.[1]?.trim()

// The team that signed a bundle, from what `codesign -dv` prints; ad-hoc signatures have none.
const teamOf = (details: string): string | undefined => {
  const team = /^TeamIdentifier=(.+)$/mu.exec(details)?.[1]?.trim()
  return team && team !== "not set" ? team : undefined
}

const problem = (sentence: string): Error => new Error(sentence)

/**
 * A downloaded update that is not one to install: not for this app, not the version
 * announced, or not signed by this app's team. Trying again would find the same, unlike a
 * failure to unpack it, which a full disk or a cleared temporary folder may cause.
 */
export class UpdateRejected extends Error {}

const rejected = (sentence: string): Error => new UpdateRejected(sentence)

// Checks the prepared bundle is the update for this very app and was signed by its maker.
const verify = async (
  prepared: string,
  update: { readonly version: string; readonly bundle: string },
  host: MacUpdateHost,
): Promise<void> => {
  const plistOf = async (bundle: string): Promise<string> => {
    try {
      return await host.readFile(posix.join(bundle, "Contents", "Info.plist"))
    } catch {
      throw rejected("The downloaded update has no readable Info.plist.")
    }
  }
  const [downloaded, running] = [await plistOf(prepared), await plistOf(update.bundle)]
  const identifier = plistString(downloaded, "CFBundleIdentifier")
  if (identifier === undefined || identifier !== plistString(running, "CFBundleIdentifier"))
    throw rejected("The downloaded update is not for this app.")
  if (plistString(downloaded, "CFBundleShortVersionString") !== update.version)
    throw rejected("The downloaded update is not the version that was announced.")
  try {
    await host.codesignVerify(prepared)
  } catch {
    throw rejected("The downloaded update's signature is not valid.")
  }
  const team = teamOf(await host.codesignDetails(prepared))
  if (team === undefined) throw rejected("The downloaded update is not signed by a developer team.")
  if (team !== teamOf(await host.codesignDetails(update.bundle)))
    throw rejected("The downloaded update was signed by a different team than this app.")
}

/**
 * Unpacks the downloaded zip into a fresh folder under the temporary folder, strips its
 * quarantine attribute and verifies it: exactly one `.app`, with this app's identifier and
 * the announced `version`, a sound signature, and the same signing team as the running
 * `bundle`, which it must have. Resolves to the prepared `.app`; rejects with an Error
 * whose message is a plain sentence, an `UpdateRejected` when the update is not one to
 * install. Nothing is left behind by a failure. Earlier prepared folders are left alone:
 * one may be on its way into place as the app quits, so the host removes them (see
 * `removeMacUpdates`).
 */
export const prepareMacUpdate = async (
  update: { readonly zip: string; readonly version: string; readonly bundle: string },
  host: MacUpdateHost = macUpdateHost,
): Promise<string> => {
  const temporary = host.tmpdir()
  let folder: string | undefined
  try {
    folder = await host.mkdtemp(posix.join(temporary, preparedPrefix))
    try {
      await host.unzip(update.zip, folder)
    } catch {
      throw problem("The downloaded update could not be unpacked.")
    }
    await host.unquarantine(folder)
    const apps = (await host.readdir(folder)).filter((name) => name.endsWith(".app"))
    if (apps.length !== 1 || apps[0] === undefined)
      throw rejected("The downloaded update does not hold exactly one app.")
    const prepared = posix.join(folder, apps[0])
    await verify(prepared, update, host)
    return prepared
  } catch (error) {
    if (folder !== undefined) await host.remove(folder).catch(() => {})
    throw error instanceof Error && error.message.endsWith(".")
      ? error
      : problem("The downloaded update could not be prepared.")
  }
}

/**
 * Removes the folders `prepareMacUpdate` made, but the one holding `keep`, if given: those
 * of updates a newer one replaced, and of an update installed, which holds the app it
 * replaced. With `olderThanMs`, a folder changed more recently than that is left too: at
 * a launch, another copy running on its own data folder may be putting its update in
 * place from one, which moves the old app into it. A folder that can't be removed is left
 * for the system to clear.
 */
export const removeMacUpdates = async (
  { keep, olderThanMs }: { readonly keep?: string; readonly olderThanMs?: number } = {},
  host: MacUpdateHost = macUpdateHost,
): Promise<void> => {
  const temporary = host.tmpdir()
  const kept = keep === undefined ? undefined : posix.dirname(keep)
  const folders = (await host.readdir(temporary).catch(() => []))
    .filter((name) => name.startsWith(preparedPrefix))
    .map((name) => posix.join(temporary, name))
    .filter((folder) => folder !== kept)
  const old = async (folder: string): Promise<boolean> =>
    olderThanMs === undefined || Date.now() - (await host.modified(folder)) >= olderThanMs
  await Promise.all(
    folders.map(async (folder) => {
      if (await old(folder)) await host.remove(folder).catch(() => {})
    }),
  )
}

// Whether a rename failed only because the two paths are on different volumes.
const crossesVolumes = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "EXDEV"

// Renames `from` to `to`; across volumes, copies into a hidden sibling of `to` and renames
// that, so `to` never holds a half-made copy, and then removes `from`.
const move = async (from: string, to: string, host: MacUpdateHost): Promise<void> => {
  try {
    await host.rename(from, to)
  } catch (error) {
    if (!crossesVolumes(error)) throw error
    const sibling = posix.join(posix.dirname(to), `.${posix.basename(to)}.new`)
    try {
      await host.remove(sibling)
      await host.copy(from, sibling)
      await host.rename(sibling, to)
    } catch (failure) {
      await host.remove(sibling).catch(() => {})
      throw failure
    }
    await host.remove(from)
  }
}

// A reason from an error, which the person can read.
const installReason = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === "EPERM" || code === "EACCES")
    return "macOS didn't allow Novadeck to replace itself. Allow it in System Settings under Privacy & Security, App Management, or install the update by hand."
  if (code === "ENOSPC") return "There is no space left on the disk."
  if (code === "EROFS") return "Novadeck is on a disk that cannot be written to."
  const text = reasonText(error instanceof Error ? error.message : "")
  return text ? `The update could not be installed: ${text}` : "The update could not be installed."
}

/**
 * Puts the prepared app in place of `bundle`: the bundle is renamed aside (into the
 * prepared update's folder) and the prepared one renamed into place. In `contents` mode
 * the same is done with the two `Contents` folders and the bundle folder stays, which is
 * all that can be done where its parent is not writable. Should a step fail, the old one
 * is put back and the install rejects. A rename between volumes copies instead. The old
 * one stays in the prepared folder, as removing it would hold up the quit, until
 * `removeMacUpdates` clears it at the next launch. Meant for the quit, once the app has
 * saved: it neither quits nor restarts anything.
 */
export const installMacUpdate = async (
  install: { readonly prepared: string; readonly bundle: string; readonly mode: MacSwapMode },
  host: MacUpdateHost = macUpdateHost,
): Promise<void> => {
  const whole = install.mode === "whole"
  const target = whole ? install.bundle : posix.join(install.bundle, "Contents")
  const source = whole ? install.prepared : posix.join(install.prepared, "Contents")
  const aside = posix.join(posix.dirname(install.prepared), whole ? "previous.app" : "previous")
  try {
    await host.remove(aside)
    await move(target, aside, host)
  } catch (error) {
    await restore(target, aside, host)
    throw problem(installReason(error))
  }
  try {
    await move(source, target, host)
  } catch (error) {
    await restore(target, aside, host)
    throw problem(installReason(error))
  }
}

// Puts the old bundle (or its Contents) back from `aside`, removing what is at `target`
// in its way. Rejects when it cannot, as then there is no app to run.
const restore = async (target: string, aside: string, host: MacUpdateHost): Promise<void> => {
  try {
    if (!(await host.exists(aside))) return
    await host.remove(target)
    await move(aside, target, host)
  } catch {
    throw problem(
      "The update failed and the previous Novadeck could not be put back. Install Novadeck again.",
    )
  }
}

// A string as one sh word, in single quotes.
const shQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

// A string as the inside of an AppleScript string literal.
const appleScriptEscape = (text: string): string =>
  text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')

/**
 * The one-time step for a bundle the person cannot write: `chown -R` of it to them, asked
 * through the system's administrator prompt. Resolves true when done, false when they
 * cancel the prompt (osascript's error -128), and rejects on any other failure.
 */
export const allowMacUpdates = async (
  allow: { readonly bundle: string; readonly uid: number; readonly gid: number },
  host: MacUpdateHost = macUpdateHost,
): Promise<boolean> => {
  if (
    !Number.isInteger(allow.uid) ||
    !Number.isInteger(allow.gid) ||
    allow.uid < 0 ||
    allow.gid < 0
  )
    throw problem("Novadeck could not tell which account to allow.")
  const command = `/usr/sbin/chown -R ${allow.uid}:${allow.gid} ${shQuote(allow.bundle)}`
  const script = `do shell script "${appleScriptEscape(command)}" with administrator privileges`
  try {
    await host.osascript(script)
    return true
  } catch (error) {
    const text = error instanceof Error ? error.message : ""
    if (/\(-128\)/u.test(text)) return false
    throw problem(`Novadeck could not be allowed to update itself. ${reasonText(text)}`.trim())
  }
}
