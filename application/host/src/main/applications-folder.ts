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
 * What Electron's `moveToApplicationsFolder` does when the Applications folder already
 * holds an app of the same name: replace a copy that is not running, as the person asked
 * for this one to take its place, unless that copy is a newer version than this one, and
 * leave one that runs, which this must not quit. `existingVersion` is the version the
 * copy in Applications reports, when it can be read.
 */
export const resolveMoveConflict = (
  conflict: "exists" | "existsAndRunning",
  {
    existingVersion,
    runningVersion,
  }: { existingVersion: string | undefined; runningVersion: string },
): "replace" | "newer" | "running" => {
  if (conflict === "existsAndRunning") return "running"
  if (existingVersion !== undefined && isNewerVersion(existingVersion, runningVersion))
    return "newer"
  return "replace"
}

/**
 * The `CFBundleShortVersionString` in the text of an XML `Info.plist`, if it has one.
 */
export const bundleVersionOf = (plist: string): string | undefined =>
  /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,100})<\/string>/u
    .exec(plist)?.[1]
    ?.trim()

/** How a move to Applications went. */
export type MoveOutcome =
  /** The app is copied, and Electron is quitting it to start the copy. */
  | { readonly kind: "moved" }
  /** Applications holds a newer copy, `version`, which was left alone. */
  | { readonly kind: "newer"; readonly version: string }
  | { readonly kind: "failed"; readonly reason: string }

// A reason from an error's message, or a general one where it has none.
const reasonOf = (error: unknown): string =>
  reasonText(error instanceof Error ? error.message : "") || "Moving to Applications failed."

/**
 * Why a move must not go ahead when the running bundle was renamed: Electron writes the
 * copy to `/Applications/<running name>`, so a copy `running` named otherwise (Finder and
 * Archive Utility add " 2" to a name already taken) would sit beside an older installed
 * one under the `packaged` name, which stays launchable and never runs the launch check.
 * Undefined when the names agree or no such copy is installed (`installed`).
 */
export const renamedMoveReason = ({
  running,
  packaged,
  installed,
}: {
  readonly running: string
  readonly packaged: string
  readonly installed: boolean
}): string | undefined =>
  running === packaged || !installed
    ? undefined
    : reasonText(
        `This copy is named ${running}, and ${packaged} is already in Applications. ` +
          `Rename this copy to ${packaged}, or remove the old one, and try again.`,
      )

/**
 * Moves the app to Applications with Electron's `moveToApplicationsFolder`, passed as
 * `move`. On success Electron has copied the app, deleted the original (or trashed it where
 * deleting fails; a read-only translocated copy stays, and a disk image's is never touched),
 * started a script that opens the copy once this process ends,
 * and called `app.quit()` itself, all before `move` returns true (see
 * `ElectronBundleMover::Move`); the quit runs the app's own shutdown, so nothing here quits.
 * The move is made before any shutdown on purpose: it can fail, and the person's shells
 * should survive that. A copy in Applications that is a newer version than this one is
 * never replaced: the move is cancelled and the answer is `newer`. Electron throws for a
 * failed copy or a refused authorization, and returns false for a conflict this turned down
 * or for what it will not do; either says why in a `failed` answer.
 */
export const moveToApplications = ({
  move,
  existingVersion,
  runningVersion,
  log,
}: {
  /** Electron's `moveToApplicationsFolder`, given the handler for a copy already there. */
  readonly move: (conflictHandler: (conflict: "exists" | "existsAndRunning") => boolean) => boolean
  /** The version of the copy in Applications, when it can be read. */
  readonly existingVersion: () => string | undefined
  readonly runningVersion: string
  readonly log: (message: string, error: unknown) => void
}): MoveOutcome => {
  // What the conflict handler found, if Electron asked it.
  const found: { answer: ReturnType<typeof resolveMoveConflict>; version?: string } = {
    answer: "replace",
  }
  try {
    const moved = move((conflict) => {
      const existing = existingVersion()
      found.answer = resolveMoveConflict(conflict, { existingVersion: existing, runningVersion })
      if (existing !== undefined) found.version = existing
      return found.answer === "replace"
    })
    if (moved) return { kind: "moved" }
  } catch (error) {
    log("Moving to Applications failed.", error)
    return { kind: "failed", reason: reasonOf(error) }
  }
  if (found.answer === "newer" && found.version !== undefined)
    return { kind: "newer", version: found.version }
  return {
    kind: "failed",
    reason:
      found.answer === "running"
        ? "Novadeck is already running from Applications."
        : "Moving to Applications was cancelled.",
  }
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
