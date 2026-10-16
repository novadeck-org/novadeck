// macOS paths, whichever system the tests run on.
import { posix } from "node:path"

import { updateVersionPattern } from "@novadeck/protocol/bridge"

import type { InstalledCopy } from "./install-linux.js"
import { reasonText } from "./install-reason.js"

// A version as numbers and a prerelease tag, or undefined for text that is not one.
const parseVersion = (
  version: string,
): { readonly numbers: readonly number[]; readonly pre: string | undefined } | undefined => {
  const match = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?$/u.exec(version.trim())
  if (!match) return undefined
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] }
}

/**
 * Whether `existing` is a newer version than `running`. A version that is not a release's
 * is not newer. A release is newer than its own prereleases; prereleases compare as text.
 */
export const isNewerVersion = (existing: string, running: string): boolean => {
  const [one, other] = [parseVersion(existing), parseVersion(running)]
  if (!one || !other) return false
  for (const [index, number] of one.numbers.entries()) {
    const against = other.numbers[index] ?? 0
    if (number !== against) return number > against
  }
  if (one.pre === other.pre) return false
  if (one.pre === undefined) return true
  if (other.pre === undefined) return false
  return one.pre > other.pre
}

/**
 * The `CFBundleShortVersionString` in the text of an XML `Info.plist`, if it has one.
 */
export const bundleVersionOf = (plist: string): string | undefined =>
  /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,100})<\/string>/u
    .exec(plist)?.[1]
    ?.trim()

/** How installing the bundle went: where it now is, or why nothing was installed. */
export type BundleInstall =
  | { readonly kind: "installed"; readonly image: string }
  | { readonly kind: "failed"; readonly reason: string }

/** What installing the app bundle asks of the machine. */
export type BundleInstallHost = {
  /** The running bundle, which is copied. */
  readonly running: string
  /** The running app's version. */
  readonly version: string
  /** The version the bundle at `path` names, when it can be read. */
  readonly versionOf: (path: string) => Promise<string | undefined>
  /** The bundle name the app is installed under, `novadeck.app`, whatever the running one is called. */
  readonly packaged: string
  /** The system Applications folder and the person's own, in the order a new copy is put. */
  readonly applications: string
  readonly userApplications: string
  readonly exists: (path: string) => Promise<boolean>
  /** Whether the person can write to `path`, a file or a folder. */
  readonly writable: (path: string) => Promise<boolean>
  readonly mkdir: (folder: string) => Promise<void>
  /** `ditto <source> <destination>`: copies a bundle whole, keeping what it carries. */
  readonly ditto: (source: string, destination: string) => Promise<void>
  /** `xattr -dr com.apple.quarantine <path>`. */
  readonly unquarantine: (path: string) => Promise<void>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly remove: (path: string) => Promise<void>
  readonly log: (message: string, error: unknown) => void
}

// A reason from an error, or a general one where it has none.
const reasonOf = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === "ENOSPC") return "There is no space left on the disk."
  if (code === "EACCES" || code === "EPERM" || code === "EROFS")
    return "Novadeck cannot write to the Applications folder."
  return reasonText(error instanceof Error ? error.message : "") || "Installing failed."
}

const failed = (reason: string): BundleInstall => ({ kind: "failed", reason })

/** What recovering from an interrupted install asks of the machine. */
export type BundleRecoveryHost = Pick<
  BundleInstallHost,
  "applications" | "userApplications" | "exists" | "rename" | "remove" | "log"
> & {
  /** The bundle names an installed copy may have: the packaged one, and a renamed copy's. */
  readonly names: readonly string[]
}

/**
 * Tidies what an install interrupted by a quit or a failed rollback leaves in the two
 * Applications folders: a copy renamed aside while its replacement is not in place is put
 * back (it may be the only installed copy), and a half-made copy is removed, as is an
 * aside next to a copy that is there, for each of `names`. Returns the copy it restored, if any. Run before an
 * install and at the launch of a portable copy; nothing else runs then, as one instance
 * holds the data folder.
 */
export const recoverBundles = async (host: BundleRecoveryHost): Promise<string | undefined> => {
  const tidy = async (place: readonly [string, string]): Promise<string | undefined> => {
    const [folder, name] = place
    const target = posix.join(folder, name)
    const aside = posix.join(folder, `.${name}.old`)
    const staged = posix.join(folder, `.${name}.new`)
    let restored: string | undefined
    try {
      if (await host.exists(aside)) {
        if (await host.exists(target)) await host.remove(aside)
        else {
          await host.rename(aside, target)
          restored = target
        }
      }
      if (await host.exists(staged)) await host.remove(staged)
    } catch (error) {
      host.log("An interrupted install could not be tidied.", error)
    }
    return restored
  }
  const places = [host.applications, host.userApplications].flatMap((folder) =>
    [...new Set(host.names)].map((name): readonly [string, string] => [folder, name]),
  )
  const restored = await Promise.all(places.map(tidy))
  return restored.find((each) => each !== undefined)
}

/**
 * Installs the running bundle as a copy, and leaves this app running. The target is the
 * installed copy being replaced (`existing`), else `/Applications/<packaged name>` where
 * that folder can be written, else the same in `~/Applications`. The bundle is copied
 * with `ditto` into a hidden folder beside the target, stripped of its quarantine
 * attribute (without which the system would run the installed copy translocated, and it
 * would take itself for a portable one), and then swapped in: the old copy is renamed
 * aside, the new one renamed into place, the old one removed. Should the second rename
 * fail, the old copy is put back. A copy the person cannot write to belongs to another
 * account, and nothing is written. An installed copy of the same version as this one, or
 * this very bundle, is left alone and counts as installed. The running bundle is left where it is. Unlike
 * Electron's `moveToApplicationsFolder`, nothing here quits or relaunches the app.
 */
export const installBundle = async (
  existing: string | undefined,
  host: BundleInstallHost,
): Promise<BundleInstall> => {
  const names = existing === undefined ? [host.packaged] : [host.packaged, posix.basename(existing)]
  const restored = await recoverBundles({ ...host, names })
  existing ??= restored
  let target: string
  if (existing !== undefined) {
    // Never replace the bundle this app runs from. A translocated copy of the one in
    // Applications runs from another path, but names the same version, so the version
    // check is what leaves it alone; there is nothing to install.
    if (existing === host.running || (await host.versionOf(existing)) === host.version)
      return { kind: "installed", image: existing }
    target = existing
    if (!(await host.writable(existing)) || !(await host.writable(posix.dirname(existing))))
      return failed(
        "Novadeck in Applications belongs to another account on this Mac. Remove it and try again.",
      )
  } else if (await host.writable(host.applications)) {
    target = posix.join(host.applications, host.packaged)
  } else {
    target = posix.join(host.userApplications, host.packaged)
    try {
      await host.mkdir(host.userApplications)
    } catch (error) {
      host.log("The Applications folder could not be made.", error)
      return failed(reasonOf(error))
    }
  }
  const folder = posix.dirname(target)
  const name = posix.basename(target)
  const staged = posix.join(folder, `.${name}.new`)
  const aside = posix.join(folder, `.${name}.old`)
  try {
    await host.remove(staged)
    await host.remove(aside)
    await host.ditto(host.running, staged)
    await host.unquarantine(staged)
  } catch (error) {
    host.log("The copy could not be made.", error)
    await host.remove(staged).catch(() => {})
    return failed(reasonOf(error))
  }
  try {
    const replacing = await host.exists(target)
    if (replacing) await host.rename(target, aside)
    try {
      await host.rename(staged, target)
    } catch (error) {
      if (replacing) await host.rename(aside, target).catch(() => {})
      throw error
    }
  } catch (error) {
    host.log("The copy could not be put in place.", error)
    await host.remove(staged).catch(() => {})
    // macOS 13 and later let an app replace another only with the person's consent
    // (App Management), refusing with EPERM.
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === "EPERM" || code === "EACCES")
      return failed(
        "macOS didn't allow replacing the installed Novadeck. Remove it yourself and try again.",
      )
    return failed(reasonOf(error))
  }
  await host
    .remove(aside)
    .catch((error: unknown) => host.log("The replaced copy could not be removed.", error))
  return { kind: "installed", image: target }
}

/** What finding the copies installed in Applications folders looks at of the machine. */
export type InstalledAppsHost = {
  /** The Applications folders to look in, in the order a copy is replaced. */
  readonly folders: readonly string[]
  /**
   * The bundle names to look for in each folder, the running copy's first: Finder may have
   * renamed a portable copy (`novadeck 2.app`), and the installed one keeps the packaged name.
   * A name given twice is looked for once.
   */
  readonly names: readonly string[]
  readonly exists: (path: string) => Promise<boolean>
  readonly readFile: (path: string) => Promise<string>
}

/**
 * The copies of the app installed in the given bundles that exist, each with the version
 * its `Info.plist` names. A bundle whose `Info.plist` cannot be read is `unchecked`: it may
 * well be a newer app. One whose plist names no release version has none, and is not
 * known to be newer.
 */
export const findInstalledApps = async ({
  folders,
  names,
  exists,
  readFile,
}: InstalledAppsHost): Promise<InstalledCopy[]> => {
  const copy = async (image: string): Promise<InstalledCopy | undefined> => {
    if (!(await exists(image))) return undefined
    try {
      const version = bundleVersionOf(await readFile(`${image}/Contents/Info.plist`))
      const known = version !== undefined && updateVersionPattern.test(version)
      return { image, version: known ? version : undefined, unchecked: false }
    } catch {
      return { image, version: undefined, unchecked: true }
    }
  }
  const bundles = new Set(folders.flatMap((folder) => names.map((name) => `${folder}/${name}`)))
  const copies = await Promise.all([...bundles].map(copy))
  return copies.filter((each) => each !== undefined)
}

/**
 * Starts the copy of the app in Applications in place of this one: relaunches into its
 * executable and ends this process. Returns whether it did, which is not when the
 * executable is not there, or the relaunch fails; the launch then goes on in this copy.
 * Launching the bundle through the system instead would not do: it has this app's
 * identifier, so the system may only bring this running instance forward.
 */
export const relaunchIntoCopy = ({
  executable,
  exists,
  relaunch,
  exit,
  log,
}: {
  readonly executable: string
  readonly exists: (path: string) => boolean
  readonly relaunch: (executable: string) => void
  readonly exit: () => void
  readonly log: (message: string, error: unknown) => void
}): boolean => {
  try {
    if (!exists(executable)) {
      log("The newer copy has no executable to start.", executable)
      return false
    }
    relaunch(executable)
  } catch (error) {
    log("The newer copy did not start.", error)
    return false
  }
  exit()
  return true
}
