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
  /**
   * The version an install on quitting began to put in place, until a launch has seen
   * whether it did; see `installOutcome`.
   */
  readonly installing: string | undefined
  /** The version the app last launched as, to tell an update from a fresh install. */
  readonly lastRunVersion: string | undefined
  /**
   * The version whose release notes the person has yet to be shown, until they dismiss
   * them or the release turns out to have nothing to show; see ./whats-new.ts.
   */
  readonly whatsNewPending: string | undefined
  /**
   * The newest version whose notes were settled, shown and dismissed or found to have
   * nothing to show. No version at or below it is offered again, so a downgrade, or a
   * portable and an installed copy sharing this file, never bring a dismissed card back.
   */
  readonly whatsNewSettled: string | undefined
}

const defaults: UpdateState = {
  channel: "stable",
  installFailedOn: undefined,
  installing: undefined,
  lastRunVersion: undefined,
  whatsNewPending: undefined,
  whatsNewSettled: undefined,
}

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
  const { channel, installFailedOn, installing, lastRunVersion, whatsNewPending, whatsNewSettled } =
    kept as Record<string, unknown>
  return {
    channel: updateChannels.find((known) => known === channel) ?? defaults.channel,
    installFailedOn: typeof installFailedOn === "string" ? installFailedOn : undefined,
    installing: typeof installing === "string" ? installing : undefined,
    lastRunVersion: typeof lastRunVersion === "string" ? lastRunVersion : undefined,
    whatsNewPending: typeof whatsNewPending === "string" ? whatsNewPending : undefined,
    whatsNewSettled: typeof whatsNewSettled === "string" ? whatsNewSettled : undefined,
  }
}

/**
 * What a launch learns of the install the last quit began, if any: `failed` when this
 * build is older than the version it was putting in place, as when the installer failed
 * after the app exited or the swap was undone, else `done`. `newer` tells whether its
 * first version is newer than its second.
 */
export const installOutcome = (
  state: Pick<UpdateState, "installing">,
  version: string,
  newer: (a: string, b: string) => boolean,
): "failed" | "done" | undefined => {
  if (state.installing === undefined) return undefined
  return newer(state.installing, version) ? "failed" : "done"
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
    /** Marks that installing failed on `version`, which settles any install begun. */
    recordInstallFailure: (version: string): void =>
      change({ installFailedOn: version, installing: undefined }),
    /** Marks that an install on quitting began to put `version` in place. */
    recordInstalling: (version: string): void => change({ installing: version }),
    /** Marks that a launch has seen how the install begun last ended. */
    clearInstalling: (): void => change({ installing: undefined }),
    /** Marks the version this launch runs, and which version's notes are yet to be shown. */
    recordLaunch: (lastRunVersion: string, whatsNewPending: string | undefined): void =>
      change({ lastRunVersion, whatsNewPending }),
    /**
     * Marks that the notes of `version` are settled: seen, or none to see. The newest
     * version settled is kept, so settling an older one after a downgrade moves nothing back.
     * `newer` tells whether its first version is newer than its second.
     */
    settleWhatsNew: (version: string, newer: (a: string, b: string) => boolean): void => {
      const { whatsNewSettled } = read()
      change({
        whatsNewPending: undefined,
        whatsNewSettled:
          whatsNewSettled !== undefined && newer(whatsNewSettled, version)
            ? whatsNewSettled
            : version,
      })
    },
  }
}
