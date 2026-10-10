/** What decides whether a launch offers to move the app to the Applications folder. */
export type MoveBuild = {
  readonly packaged: boolean
  readonly version: string
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  /** Electron's `app.isInApplicationsFolder()`; only macOS has an answer. */
  readonly inApplications: boolean
  /** Whether the person asked not to be offered the move again. */
  readonly declined: boolean
  /** Whether the app bundle is Developer ID signed; unsigned builds do not update. */
  readonly signed: boolean
}

/**
 * Whether a launch offers to move the app to Applications. macOS updates an app only in
 * place, and cannot replace one that runs from a disk image or, after a download, from a
 * randomized read-only copy, so the offer is made on a packaged macOS launch from any
 * other folder, until the person asks not to be asked again. Only a signed build is
 * asked: an unsigned one only tells of updates, and the offer promises one that installs.
 * A development run, a build
 * that carries version 0.0.0 (it never updates), and a launch with `NOVADECK_UPDATES=off`,
 * as the smoke tests give, never ask.
 */
export const shouldOfferMove = ({
  packaged,
  version,
  platform,
  env,
  inApplications,
  declined,
  signed,
}: MoveBuild): boolean =>
  platform === "darwin" &&
  packaged &&
  version !== "0.0.0" &&
  env.NOVADECK_UPDATES !== "off" &&
  !inApplications &&
  !declined &&
  signed

/** The person's answer to the offer. */
export type MoveAnswer = {
  readonly move: boolean
  /** Whether "Don't ask again" was ticked, whichever button was pressed. */
  readonly dontAskAgain: boolean
}

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

/** How a move went: started, not done (turned down by Electron, or failed), or cancelled for a newer copy. */
export type MoveResult = "moved" | "declined" | "newer"

/**
 * The `CFBundleShortVersionString` in the text of an XML `Info.plist`, if it has one.
 */
export const bundleVersionOf = (plist: string): string | undefined =>
  /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,100})<\/string>/u
    .exec(plist)?.[1]
    ?.trim()

/**
 * Offers the move on a launch that should, and does it when accepted. Returns whether the
 * app is on its way to restart from Applications, in which case the launch goes no
 * further. A move that fails or is turned down lets the launch go on where it is. "Don't
 * ask again" is kept whatever else happens; the buttons alone ask again at the next launch.
 * A move cancelled because Applications holds a newer copy says so, and the person may
 * open that copy instead, which also ends this launch. Whether the build is signed, which
 * takes a `codesign` run, is asked only once nothing else rules the offer out.
 */
export const offerMove = async ({
  build,
  signed,
  ask,
  decline,
  move,
  tellNewer,
  log,
}: {
  readonly build: Omit<MoveBuild, "signed">
  readonly signed: () => Promise<boolean>
  readonly ask: () => Promise<MoveAnswer>
  readonly decline: () => void
  /** Electron's `moveToApplicationsFolder`. */
  readonly move: () => MoveResult
  /** Tells the person a newer copy is in Applications; true if they want that one opened. */
  readonly tellNewer: () => Promise<boolean>
  readonly log: (message: string, error: unknown) => void
}): Promise<boolean> => {
  // Everything but the signature, which is asked last.
  if (!shouldOfferMove({ ...build, signed: true })) return false
  try {
    if (!(await signed())) return false
    const answer = await ask()
    if (answer.dontAskAgain) {
      try {
        decline()
      } catch (error) {
        log("The choice was not kept.", error)
      }
    }
    if (!answer.move) return false
    const result = move()
    return result === "moved" || (result === "newer" && (await tellNewer()))
  } catch (error) {
    log("Moving to Applications failed.", error)
    return false
  }
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
