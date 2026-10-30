// Notes and checks for a portable copy that may hand a launch over to an installed one.

import { currentOrNewerCopy, type InstalledCopy } from "../install/linux.js"
import { isNewerVersion } from "../releases/versions.js"

/** What a launch of a portable copy does about an installed copy of the same version or newer. */
export type InstalledCopyCheck = {
  readonly portable: boolean
  readonly version: string
  readonly find: () => Promise<readonly InstalledCopy[]>
  /**
   * Starts the installed copy `image` in place of this one and ends this process; false if
   * it could not start.
   */
  readonly start: (image: string) => Promise<boolean>
  /** Tells the person that the installed copy at `image` would not start. */
  readonly alert: (image: string) => Promise<void>
  /** Whether this copy redirected a launch to an installed copy of the same version just now. */
  readonly recentRedirect: () => boolean
  /** Notes that this copy is redirecting a launch to an installed copy of the same version. */
  readonly markRedirect: () => void
  readonly quit: () => void
  readonly log: (message: string, error: unknown) => void
}

/**
 * Before a portable copy starts anything, checks for an installed copy of the same
 * version or a newer one, and if there is one starts it in place of this launch, without
 * asking: the person opened Novadeck, and the installed copy is the one they keep. A
 * newer copy must also not be shadowed by this one: it may have upgraded the database,
 * which an older runner refuses to open. So if a newer copy will not start, the person is
 * told and this copy quits; if one of the same version will not start, this copy carries
 * on, as it can open the same workspace. Returns whether the launch is over, which it is
 * when the installed copy started, or this copy quit, and not when none is found, only
 * an older or unchecked copy exists, or the copies cannot be listed; then the launch goes
 * on. A copy that could not be looked at counts as none: the runner refuses a workspace
 * that is too new, which is the fallback.
 */
export const leaveForNewerInstalled = async (check: InstalledCopyCheck): Promise<boolean> => {
  if (!check.portable) return false
  let copy: ReturnType<typeof currentOrNewerCopy>
  try {
    copy = currentOrNewerCopy(await check.find(), check.version)
  } catch (error) {
    check.log("The installed copies could not be looked at.", error)
    return false
  }
  if (!copy) return false
  const same = !isNewerVersion(copy.version, check.version)
  // An installed copy of the same version that the system starts and ends at once (a
  // quarantined or damaged bundle) would make every launch open nothing; so a launch soon
  // after a redirect stays here. A newer copy is never skipped: this one may not open its data.
  if (same && check.recentRedirect()) {
    check.log("Redirected to the installed copy just now; carrying on in this one.", copy.image)
    return false
  }
  if (same) check.markRedirect()
  if (await check.start(copy.image)) return true
  if (same) {
    check.log("The installed copy did not start; carrying on in this one.", copy.image)
    return false
  }
  await check.alert(copy.image)
  check.quit()
  return true
}

/** The files a redirect marker uses. */
export type MarkerFiles = {
  /** When the file was last written, in ms since the epoch; throws where there is none. */
  readonly modified: (file: string) => number
  readonly write: (file: string) => void
  readonly remove: (file: string) => void
}

/**
 * The note a portable copy leaves in the data folder when it redirects to an installed copy
 * of the same version, which the installed copy clears as it starts: `recent` is true
 * only if a redirect was made within `windowMs` and the installed copy has not started
 * since. So a launch that follows a redirect the installed copy never answered stays in
 * the portable copy, and one after the installed copy ran and was quit redirects again.
 * Failures to read, write or clear are not fatal: the note is then absent or stale.
 */
export const redirectMarker = (
  file: string,
  windowMs: number,
  files: MarkerFiles,
  now: () => number,
  log: (message: string, error: unknown) => void,
) => ({
  recent: (): boolean => {
    try {
      return now() - files.modified(file) < windowMs
    } catch {
      return false
    }
  },
  mark: (): void => {
    try {
      files.write(file)
    } catch (error) {
      log("The redirect was not noted.", error)
    }
  },
  clear: (): void => {
    try {
      files.remove(file)
    } catch (error) {
      log("The redirect note was not cleared.", error)
    }
  },
})
