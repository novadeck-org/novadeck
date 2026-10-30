import { execFile } from "node:child_process"
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import { homedir } from "node:os"
import { posix } from "node:path"

import { reasonText } from "../install/reason.js"

/**
 * How the running bundle can be replaced: the whole `.app`, or only its `Contents` where
 * the folder holding it (such as `/Applications`) is not the person's to write.
 */
export type MacSwapMode = "whole" | "contents"

/** What updating the app bundle asks of the machine. */
export type MacUpdateHost = {
  /**
   * The folder that holds prepared updates, and an old bundle once replaced: in the
   * person's caches, which the system does not clear file by file as it does the
   * temporary folder, so a prepared app is never left half there.
   */
  readonly folder: () => string
  /** The names in a folder. */
  readonly readdir: (folder: string) => Promise<string[]>
  readonly readFile: (path: string) => Promise<string>
  /**
   * Makes a new folder named `prefix` and a random suffix, and the folders above it,
   * and returns its path.
   */
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
  /**
   * `codesign --verify --deep --strict [-R <requirement>] <bundle>`; rejects when the
   * signature is not sound or does not meet `requirement`, with the exit status as the
   * error's `code`, or when it could not be checked.
   */
  readonly codesignVerify: (bundle: string, requirement?: string) => Promise<void>
  /** What `codesign -dv <bundle>` prints. */
  readonly codesignDetails: (bundle: string) => Promise<string>
  /** `osascript -e <script>`; rejects with the error text osascript printed. */
  readonly osascript: (script: string) => Promise<void>
}

// Runs a tool; a failure keeps its exit status (`code`) and whether it was stopped.
const run = (file: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 300_000 }, (error, stdout, stderr) => {
      if (error)
        reject(
          Object.assign(new Error(stderr.trim() || error.message), {
            code: error.code,
            killed: error.killed,
          }),
        )
      else resolve(`${stdout}${stderr}`)
    })
  })

/** Real host: `node:fs/promises`, and `/usr/bin/ditto`, `codesign`, `xattr` and `osascript`. */
export const macUpdateHost: MacUpdateHost = {
  folder: () => posix.join(homedir(), "Library", "Caches", "dev.mzpk.novadeck.updates"),
  readdir: (folder) => readdir(folder),
  readFile: (path) => readFile(path, "utf8"),
  mkdtemp: async (prefix) => {
    await mkdir(posix.dirname(prefix), { recursive: true })
    return mkdtemp(prefix)
  },
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
  codesignVerify: async (bundle, requirement) =>
    void (await run("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      ...(requirement === undefined ? [] : ["-R", requirement]),
      bundle,
    ])),
  codesignDetails: (bundle) => run("/usr/bin/codesign", ["-dv", bundle]),
  osascript: async (script) => void (await run("/usr/bin/osascript", ["-e", script])),
}

// A prepared update lives in a folder of this name in the updates folder, which is how
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
 * failure to unpack or check it, which a full disk or a stopped `codesign` may cause.
 */
export class UpdateRejected extends Error {}

const rejected = (sentence: string): Error => new UpdateRejected(sentence)

/**
 * An install left for a later quit, as when the prepared app's signature could not be
 * checked again: nothing is wrong with the update, and the old app is untouched.
 */
export class InstallPostponed extends Error {}

// Whether `codesign --verify` ran and found the signature unsound: it exits 1 for a bad
// signature and 3 for one that fails its requirement; any other failure, as a timeout,
// leaves it unchecked.
const unsound = (error: unknown): boolean => {
  const { code, killed } = (error ?? {}) as { code?: unknown; killed?: unknown }
  return killed !== true && (code === 1 || code === 3)
}

// Checks the prepared bundle is the update for this very app and was signed by its maker.
// What a team identifier looks like: ten capitals and digits.
const teamPattern = /^[A-Z0-9]{10}$/u

/**
 * The requirement an update is held to, the one a Developer ID app carries as its own
 * and Squirrel.Mac held updates to: signed through Apple's certificate chain, by a
 * Developer ID Application certificate (its leaf field) from the Developer ID
 * authority (its issuer's), of the running app's `team`. The `TeamIdentifier` a
 * signature names is not enough, as any certificate can carry one.
 */
export const updateRequirement = (team: string): string =>
  "=anchor apple generic" +
  " and certificate 1[field.1.2.840.113635.100.6.2.6] exists" +
  " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists" +
  ` and certificate leaf[subject.OU] = "${team}"`

// The team that signed the running app, which an update must share.
const runningTeam = async (bundle: string, host: MacUpdateHost): Promise<string> => {
  let details: string
  try {
    details = await host.codesignDetails(bundle)
  } catch {
    throw problem("This app's signature could not be read.")
  }
  const team = teamOf(details)
  if (team === undefined || !teamPattern.test(team))
    throw rejected("This app is not signed by a developer team, so no update can be checked.")
  return team
}

// Checks `bundle` is soundly signed through Apple's chain by `team`.
const signedBy = async (bundle: string, team: string, host: MacUpdateHost): Promise<void> => {
  try {
    await host.codesignVerify(bundle, updateRequirement(team))
  } catch (error) {
    if (unsound(error))
      throw rejected("The downloaded update's signature is not valid for this app's team.")
    throw problem("The downloaded update's signature could not be checked.")
  }
}

// Checks the prepared bundle is the update for this very app and was signed by its maker.
const verify = async (
  prepared: string,
  update: { readonly version: string; readonly bundle: string },
  host: MacUpdateHost,
): Promise<void> => {
  const plistOf = (bundle: string): Promise<string> =>
    host.readFile(posix.join(bundle, "Contents", "Info.plist"))
  const downloaded = await plistOf(prepared).catch(() => {
    throw rejected("The downloaded update has no readable Info.plist.")
  })
  // The running app's own, which a move of the app while it runs may hide for a while.
  const running = await plistOf(update.bundle).catch(() => {
    throw problem("This app's Info.plist could not be read.")
  })
  const identifier = plistString(downloaded, "CFBundleIdentifier")
  if (identifier === undefined || identifier !== plistString(running, "CFBundleIdentifier"))
    throw rejected("The downloaded update is not for this app.")
  if (plistString(downloaded, "CFBundleShortVersionString") !== update.version)
    throw rejected("The downloaded update is not the version that was announced.")
  const team = await runningTeam(update.bundle, host)
  await signedBy(prepared, team, host)
  if (teamOf(await host.codesignDetails(prepared)) !== team)
    throw rejected("The downloaded update was signed by a different team than this app.")
}

/**
 * Unpacks the downloaded zip into a fresh folder in the updates folder, strips any
 * quarantine attribute and verifies it: exactly one `.app`, with this app's identifier and
 * the announced `version`, and signed through Apple's chain by the running `bundle`'s team
 * (see `updateRequirement`), which it must have. Resolves to the prepared `.app`; rejects with an Error
 * whose message is a plain sentence, an `UpdateRejected` when the update is not one to
 * install. Nothing is left behind by a failure. Earlier prepared folders are left alone:
 * one may be on its way into place as the app quits, so the host removes them (see
 * `removeMacUpdates`).
 */
export const prepareMacUpdate = async (
  update: { readonly zip: string; readonly version: string; readonly bundle: string },
  host: MacUpdateHost = macUpdateHost,
): Promise<string> => {
  let folder: string | undefined
  try {
    folder = await host.mkdtemp(posix.join(host.folder(), preparedPrefix))
    try {
      await host.unzip(update.zip, folder)
    } catch {
      throw problem("The downloaded update could not be unpacked.")
    }
    // A download electron-updater made carries none, so a failure here changes nothing.
    await host.unquarantine(folder).catch(() => {})
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

// What a swap leaves beside `target`, the bundle or its `Contents`, while it runs: the new
// one, staged in the same folder so the swap is two renames there, and the old one aside.
const sidesOf = (target: string): { readonly staged: string; readonly aside: string } => {
  const folder = posix.dirname(target)
  const name = posix.basename(target)
  return {
    staged: posix.join(folder, `.${name}.new`),
    aside: posix.join(folder, `.${name}.previous`),
  }
}

/**
 * Removes the folders `prepareMacUpdate` made, but the one holding `keep`, if given: those
 * of updates a newer one replaced, and of an update installed, which holds the app it
 * replaced. Given the `bundle`, it also removes what an install left beside it or its
 * `Contents` (see `installMacUpdate`). With `olderThanMs`, anything changed more recently
 * than that is left: another copy running on its own data folder may be installing from
 * it. Anything that can't be removed is left for a later launch.
 */
export const removeMacUpdates = async (
  {
    keep,
    bundle,
    olderThanMs,
  }: { readonly keep?: string; readonly bundle?: string; readonly olderThanMs?: number } = {},
  host: MacUpdateHost = macUpdateHost,
): Promise<void> => {
  const folder = host.folder()
  const kept = keep === undefined ? undefined : posix.dirname(keep)
  const prepared = (await host.readdir(folder).catch(() => []))
    .filter((name) => name.startsWith(preparedPrefix))
    .map((name) => posix.join(folder, name))
    .filter((path) => path !== kept)
  const beside =
    bundle === undefined
      ? []
      : [bundle, posix.join(bundle, "Contents")].flatMap((target) => {
          const { staged, aside } = sidesOf(target)
          return [staged, aside]
        })
  const old = async (path: string): Promise<boolean> =>
    olderThanMs === undefined || Date.now() - (await host.modified(path)) >= olderThanMs
  await Promise.all(
    [...prepared, ...beside].map(async (path) => {
      if ((await host.exists(path)) && (await old(path))) await host.remove(path).catch(() => {})
    }),
  )
}

// Whether a rename failed only because the two paths are on different volumes.
const crossesVolumes = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "EXDEV"

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
 * Checks the prepared app again just before it is put in place: it waited in the person's
 * caches, which anything they run can write, and goes where only this app may put it.
 * Rejects when it no longer passes, or with `InstallPostponed` when the check could not
 * run at all, as when `codesign` was stopped, for a later session to try again.
 */
export const recheckMacUpdate = async (
  install: { readonly prepared: string; readonly bundle: string },
  host: MacUpdateHost = macUpdateHost,
): Promise<void> => {
  try {
    await signedBy(install.prepared, await runningTeam(install.bundle, host), host)
  } catch (error) {
    if (error instanceof UpdateRejected)
      throw problem("The prepared update no longer passes its signature check.")
    throw new InstallPostponed(
      `The prepared update could not be checked again, so a later session installs it: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Puts the prepared app in place of `bundle`. The new one is first staged beside the
 * bundle, renamed there or, across volumes, copied with `ditto`, while the old app is
 * still whole; then the old one is renamed aside and the new one into place, two renames
 * in one folder, between which alone there is no app at its path. In `contents` mode the same
 * is done with the two `Contents` folders inside the bundle, which stays: all that can be
 * done where its parent is not writable. Should a step fail, the old one is put back and
 * the install rejects. The old one then moves into the prepared update's folder, as
 * removing it would hold up the quit, until `removeMacUpdates` clears it at the next
 * launch; where that crosses volumes an old app stays beside the bundle, and old
 * `Contents` are removed at once. The host checks the prepared app again first (see
 * `recheckMacUpdate`).
 * Meant for the quit, once the app has saved: it neither quits nor restarts anything.
 */
export const installMacUpdate = async (
  install: { readonly prepared: string; readonly bundle: string; readonly mode: MacSwapMode },
  host: MacUpdateHost = macUpdateHost,
): Promise<void> => {
  const whole = install.mode === "whole"
  const target = whole ? install.bundle : posix.join(install.bundle, "Contents")
  const source = whole ? install.prepared : posix.join(install.prepared, "Contents")
  const { staged, aside } = sidesOf(target)
  const fail = async (error: unknown): Promise<never> => {
    await host.remove(staged).catch(() => {})
    throw problem(installReason(error))
  }
  try {
    await host.remove(staged)
    await host.remove(aside)
    try {
      await host.rename(source, staged)
    } catch (error) {
      if (!crossesVolumes(error)) throw error
      await host.copy(source, staged)
    }
  } catch (error) {
    return fail(error)
  }
  try {
    await host.rename(target, aside)
  } catch (error) {
    return fail(error)
  }
  try {
    await host.rename(staged, target)
  } catch (error) {
    await restore(target, aside, host)
    return fail(error)
  }
  const previous = posix.join(posix.dirname(install.prepared), whole ? "previous.app" : "previous")
  try {
    await host.rename(aside, previous)
  } catch {
    // Old `Contents` left inside the bundle would break its signature's seal, so they go
    // now, whatever the wait; an old app beside the bundle can wait for the next launch.
    if (!whole) await host.remove(aside).catch(() => {})
  }
}

// Puts the old bundle (or its Contents) back from `aside`, beside it. Rejects when it
// cannot, as then there is no app to run.
const restore = async (target: string, aside: string, host: MacUpdateHost): Promise<void> => {
  try {
    await host.remove(target)
    await host.rename(aside, target)
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
