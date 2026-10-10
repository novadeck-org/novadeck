import { randomUUID } from "node:crypto"
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"

import { updateChannels, type UpdateChannel } from "@novadeck/protocol/bridge"

/** What the host remembers across launches about updating. */
export type UpdateState = {
  /** Which releases the build follows. */
  readonly channel: UpdateChannel
  /**
   * The version of the release whose install failed, when one did. A check that finds
   * that release only tells of it; a newer release installs as usual.
   */
  readonly installFailedOn: string | undefined
  /** Whether the person asked not to be offered a move to the Applications folder again. */
  readonly moveDeclined: boolean
}

const defaults: UpdateState = { channel: "stable", installFailedOn: undefined, moveDeclined: false }

/**
 * The state in a file's text. The file is the host's own, but a damaged or edited one
 * must not break launching, so each field that is not a known value falls back to its
 * default on its own.
 */
export const updateStateOf = (text: string): UpdateState => {
  let kept: unknown
  try {
    kept = JSON.parse(text)
  } catch {
    return defaults
  }
  if (typeof kept !== "object" || kept === null) return defaults
  const { channel, installFailedOn, moveDeclined } = kept as Record<string, unknown>
  return {
    channel: updateChannels.find((known) => known === channel) ?? defaults.channel,
    installFailedOn: typeof installFailedOn === "string" ? installFailedOn : undefined,
    moveDeclined: moveDeclined === true,
  }
}

/**
 * The update state kept in `file`, a JSON file in the data folder. `read` is what the
 * file holds, or the defaults before it exists. Every change reads the file again, keeps
 * the other fields, and writes a temporary file beside `file` that it renames over, so a
 * failed write leaves the file whole. All of it is synchronous, and so one path serves
 * every change: the file is small, changes are rare, and a failed install is reported
 * as the app exits, too late for a write that waits. Changes cannot interleave.
 */
export const keepUpdateState = (file: string) => {
  const read = (): UpdateState => {
    try {
      return updateStateOf(readFileSync(file, "utf8"))
    } catch {
      return defaults
    }
  }
  const change = (patch: Partial<UpdateState>): void => {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ ...read(), ...patch }))
      renameSync(temporary, file)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }
  return {
    read,
    setChannel: (channel: UpdateChannel): void => change({ channel }),
    declineMove: (): void => change({ moveDeclined: true }),
    /** Marks that installing failed on `version`. */
    recordInstallFailure: (version: string): void => change({ installFailedOn: version }),
  }
}
