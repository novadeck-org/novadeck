import { updateVersionPattern } from "@novadeck/protocol/bridge"

import { isNewerVersion } from "../release/versions.js"

/** The file in the data folder where a portable copy leaves its path and version. */
export const portableRecordName = "portable-copy.json"

/** The longest path a record may name. */
const maxPathLength = 1024

/** A portable copy as its record names it: where to start it, and which version it is. */
export type PortableRecord = {
  /** What the system runs: the AppImage file, the Windows executable, or the macOS app bundle. */
  readonly path: string
  readonly version: string
}

/**
 * The record in the text of the record file, or undefined for text that is none: not JSON,
 * a version no release has, or a path that is not one line of plain text. The file is
 * read as untrusted, since any program of the person's may write there.
 */
export const parsePortableRecord = (text: string): PortableRecord | undefined => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const { path, version } = value as Record<string, unknown>
  if (typeof version !== "string" || !updateVersionPattern.test(version)) return undefined
  if (typeof path !== "string" || path === "" || path.length > maxPathLength) return undefined
  // eslint-disable-next-line no-control-regex -- Control characters are what it rejects.
  if (/[\x00-\x1f\x7f]/u.test(path)) return undefined
  return { path, version }
}

/** What a portable copy asks of the machine to leave and read its record. */
export type RecordHost = {
  /** The record file's text; undefined where there is none or it cannot be read, and never throws. */
  readonly read: () => string | undefined
  /** Replaces the record file whole; throws when it could not be written. */
  readonly write: (text: string) => void
  /** Whether `path` is this very copy, as the system resolves paths. */
  readonly isSelf: (path: string) => boolean
  /** Whether a copy at `path` is there and can be started. */
  readonly usable: (path: string) => boolean
  readonly log: (message: string, error: unknown) => void
}

// The record, when the file holds one.
const recorded = (host: Pick<RecordHost, "read">): PortableRecord | undefined => {
  const text = host.read()
  return text === undefined ? undefined : parsePortableRecord(text)
}

/**
 * Leaves this copy's path and version in the record, so an older portable copy started
 * later finds it. The record is left alone when it names a newer version at a path that
 * still holds a runnable copy, as when this copy ran because that one did not start; a
 * record that names this copy's own path is replaced whatever version it claims, since the
 * file there is what is running. Anything else (no record, a broken one, the same or an
 * older version, a copy that is gone) is replaced. A failure to write is logged, not fatal.
 */
export const recordPortableCopy = (
  host: RecordHost,
  own: { readonly path: string; readonly version: string },
): void => {
  const current = recorded(host)
  if (
    current !== undefined &&
    isNewerVersion(current.version, own.version) &&
    !host.isSelf(current.path) &&
    host.usable(current.path)
  )
    return
  if (current?.path === own.path && current.version === own.version) return
  try {
    host.write(`${JSON.stringify({ path: own.path, version: own.version })}\n`)
  } catch (error) {
    host.log("The portable copy was not recorded.", error)
  }
}

/** What a launch of a portable copy does about a newer portable copy. */
export type HandoffCheck = Pick<RecordHost, "read" | "isSelf" | "usable" | "log"> & {
  readonly portable: boolean
  /** This copy's version. */
  readonly version: string
  /**
   * Starts the copy at `path` in place of this one and ends this process; false if it could
   * not start.
   */
  readonly start: (path: string) => Promise<boolean>
  /** Tells the person that the newer copy at `path` would not start. */
  readonly alert: (path: string) => Promise<void>
  /**
   * The version of the installed copy that `leaveForNewerInstalled` would start in this
   * launch's place (the same version as this copy or a newer one), if there is one. It
   * wins over a recorded portable copy of the same version or an older one; a failure to
   * look counts as none.
   */
  readonly installedVersion: () => Promise<string | undefined>
  /** Whether this copy handed a launch over just now, which the copy it started has not answered. */
  readonly recentHandoff: () => boolean
  /** Notes that this copy is handing a launch over. */
  readonly markHandoff: () => void
  readonly quit: () => void
}

/**
 * Before a portable copy starts anything, and before `leaveForNewerInstalled` has its say,
 * starts the newest portable copy in place of this launch when the record names a newer
 * version than this one at a path that still holds a runnable copy, unless an installed
 * copy is at least as new as it: the installed copy is the one they keep, so on a tie it
 * wins, and `leaveForNewerInstalled` starts it. So old shortcuts keep opening the newest copy the person fetched,
 * and nobody sees the runner of an old copy refuse a workspace the new one upgraded. The
 * newer copy has to be there to start (`usable`: for a file, that it exists and can be
 * executed; for a bundle or folder, that it is complete), else this copy carries on.
 *
 * A record that is missing, broken, of the same or an older version, pointing at this very
 * copy, or at a copy that is gone or cannot be run counts as none, and the launch goes on
 * here. A launch soon after one handed over also stays: the copy it started would then
 * have handed over again, which only a record that lies about versions or a path that
 * resolves two ways can make, and this stops such a pair from starting each other for ever.
 * A newer copy that is there but will not start, as a damaged or blocked file, is not
 * skipped as a missing one is: it may already have upgraded the data this older runner
 * cannot open, so the person is told and this copy quits, as `leaveForNewerInstalled`
 * does. Returns whether the launch is over.
 */
export const leaveForNewerPortable = async (check: HandoffCheck): Promise<boolean> => {
  if (!check.portable) return false
  const record = recorded(check)
  if (record === undefined || !isNewerVersion(record.version, check.version)) return false
  if (check.isSelf(record.path) || !check.usable(record.path)) return false
  // An installed copy at least as new as the record is the one they keep, and the installed
  // check starts it; an older one would be the wrong copy to start, as the record's may
  // have upgraded the workspace that one's runner refuses.
  const installed = await check.installedVersion().catch(() => undefined)
  if (installed !== undefined && !isNewerVersion(record.version, installed)) return false
  if (check.recentHandoff()) {
    check.log("Handed over just now; carrying on in this copy.", record.path)
    return false
  }
  check.markHandoff()
  if (await check.start(record.path)) return true
  await check.alert(record.path)
  check.quit()
  return true
}
