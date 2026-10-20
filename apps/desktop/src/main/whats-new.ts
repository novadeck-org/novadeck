import { parseWhatsNew, updateVersionPattern, type WhatsNew } from "@novadeck/protocol/bridge"
import { readNotesBlock } from "@novadeck/protocol/release-notes"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import { dismissWhatsNewChannel, openWhatsNewPageChannel, whatsNewChannel } from "../bridge.js"
import type { ReleaseRepository } from "./update-release.js"

/** How long reading the release waits; the card is optional, so a slow network gives it up. */
export const releaseReadMs = 10_000
/** How long a prerelease without highlights waits before its release is read again. */
export const prereleaseRecheckMs = 24 * 60 * 60 * 1000

/**
 * What a launch records and whether it leaves the notes of this version to show. Only an
 * update shows them: a previous launch as an older version. A first launch, the same
 * version again and a downgrade show nothing, and notes pending for another version are
 * given up, as the person has moved on from it. A build that is no release's, such as a
 * development run or a pull request build carrying 0.0.0, or one without a release
 * repository to read from (`offerable` false), changes nothing, so it never stands for the
 * version an update is measured from. `newer` tells whether its first version is newer
 * than its second.
 */
export const whatsNewAtLaunch = (
  {
    previous,
    current,
    pending,
    settled,
    ranBefore,
    offerable,
  }: {
    readonly previous: string | undefined
    readonly current: string
    readonly pending: string | undefined
    /** The newest version whose notes were settled; see `UpdateState`. */
    readonly settled: string | undefined
    /**
     * Whether the data folder shows the app ran before. Builds from before the last-run
     * version was kept leave `previous` empty on installs that are not new, and this tells
     * those from a first launch: they count as updated from an unknown older version.
     */
    readonly ranBefore: boolean
    readonly offerable: boolean
  },
  newer: (a: string, b: string) => boolean,
): { readonly lastRunVersion: string; readonly pending: string | undefined } | undefined => {
  if (!offerable || current === "0.0.0" || !updateVersionPattern.test(current)) return undefined
  const updated = previous === undefined ? ranBefore : newer(current, previous)
  // A version at or below one settled is never offered, whatever else says it was updated.
  const unsettled = settled === undefined || newer(current, settled)
  return {
    lastRunVersion: current,
    pending: unsettled && (updated || pending === current) ? current : undefined,
  }
}

/**
 * What reading a release came to: its notes, none to be had ever, none for now, or none
 * yet from a prerelease, which is not read again for a while.
 */
type Reading = WhatsNew | "none" | "later" | "waiting"

// Reads the release of `version` and the highlights in its notes.
const readRelease = async (
  fetch: ReleaseFetch,
  { owner, repo }: ReleaseRepository,
  version: string,
): Promise<Reading> => {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/v${version}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Novadeck",
      },
      signal: AbortSignal.timeout(releaseReadMs),
    },
  )
  // A release that does not exist never will, but only GitHub's own answer says so: a
  // proxy or captive portal answers 404 in HTML, and that passes. Any other refusal, as a
  // rate limit or a server error, may pass too.
  if (response.status === 404) {
    const message = await response.json().then(
      (answer: unknown) =>
        typeof answer === "object" && answer !== null && "message" in answer
          ? answer.message
          : undefined,
      () => undefined,
    )
    const json = /\bjson\b/i.test(response.headers.get("content-type") ?? "")
    return json && typeof message === "string" ? "none" : "later"
  }
  if (!response.ok) return "later"
  const release: unknown = await response.json()
  const field = (name: string): unknown =>
    typeof release === "object" && release !== null && name in release
      ? (release as Record<string, unknown>)[name]
      : undefined
  // Only the release itself settles anything: an empty or odd answer that is not this
  // release, as a proxy's JSON would be, passes.
  const body = field("body")
  if (field("tag_name") !== `v${version}` || (typeof body !== "string" && body !== null))
    return "later"
  const notes = typeof body === "string" ? readNotesBlock(body) : undefined
  const shown = parseWhatsNew({
    version,
    highlights: notes?.highlights.map(({ title, line }) => ({ title, line })) ?? [],
  })
  // A prerelease has no highlights yet: promoting it writes them onto this same tag
  // before it turns stable, so an early user who installed it is shown them then.
  return shown ?? (field("prerelease") === true ? "waiting" : "none")
}

/** What reading a release uses of the network: Electron's `net.fetch`, by default. */
export type ReleaseFetch = (
  url: string,
  init: {
    readonly headers: Readonly<Record<string, string>>
    readonly signal: AbortSignal
  },
) => Promise<{
  readonly status: number
  readonly ok: boolean
  readonly headers: { get(name: string): string | null }
  json(): Promise<unknown>
}>

/**
 * What is new in the version this launch runs, while `pending` names it. The release is
 * read once per launch, the first time it is asked for, and its answer kept. When the
 * release is read and has no highlights, or does not exist, there is nothing to show
 * ever, so the pending mark is cleared. A failure to read it, offline, timed out, rate
 * limited or a server error, leaves the mark for a later launch and shows nothing now.
 * Nothing is thrown: the card is a courtesy, and `log` hears of what went wrong.
 * `repository` is where the build's releases are, or undefined for a build without one.
 */
export const keepWhatsNew = ({
  version,
  launched,
  pending,
  clear,
  checkedAt,
  recordCheck,
  now,
  repository,
  fetch,
  log,
}: {
  readonly version: string
  /** Settles when the launch has recorded what it learned, which decides `pending`. */
  readonly launched: () => Promise<void>
  readonly pending: () => string | undefined
  readonly clear: () => void
  /** When a prerelease without highlights was last read, if it was. */
  readonly checkedAt: () => number | undefined
  readonly recordCheck: (time: number) => void
  readonly now: () => number
  readonly repository: () => Promise<ReleaseRepository | undefined>
  readonly fetch: ReleaseFetch
  readonly log: (message: string, error: unknown) => void
}) => {
  const forget = (): void => {
    try {
      clear()
    } catch (error) {
      log("What is new was not marked as seen.", error)
    }
  }
  let reading: Promise<WhatsNew | undefined> | undefined
  const read = async (): Promise<WhatsNew | undefined> => {
    try {
      const source = await repository()
      if (source === undefined) return undefined
      const result = await readRelease(fetch, source, version)
      if (result === "waiting") recordCheck(now())
      if (result === "later" || result === "waiting") return undefined
      if (result === "none") forget()
      else return result
    } catch (error) {
      log("The release notes were not read.", error)
    }
    return undefined
  }
  return {
    whatsNew: async (): Promise<WhatsNew | undefined> => {
      // A page may ask before the launch has marked the version, so wait for it.
      await launched()
      // Dismissed, or never pending, or settled for another version: nothing to show.
      if (pending() !== version) return undefined
      // A prerelease whose notes were not there yet is looked at again once a day.
      const last = checkedAt()
      // A time ahead of now, as after the clock moved back, is stale, not a reason to wait.
      const since = last === undefined ? undefined : now() - last
      if (since !== undefined && since >= 0 && since < prereleaseRecheckMs) return undefined
      reading ??= read()
      return reading
    },
    dismiss: forget,
  }
}

type WhatsNewIpc = {
  on(channel: string, listener: (event: IpcMainEvent, ...values: unknown[]) => void): unknown
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown,
  ): unknown
}

/**
 * Answers the app's own pages: the request for what is new, its dismissal, and the
 * request to open the release page of the running version. `window` names the window of
 * a request from the main frame of the app's own page, or undefined for any other sender,
 * which is ignored (and told there is nothing new). The page names no version or address.
 */
export const registerWhatsNewIpc = <Window>(
  ipc: WhatsNewIpc,
  {
    window,
    whatsNew,
    dismiss,
    openPage,
  }: {
    readonly window: (event: IpcMainEvent | IpcMainInvokeEvent) => Window | undefined
    readonly whatsNew: () => Promise<WhatsNew | undefined>
    readonly dismiss: () => void
    readonly openPage: () => void
  },
): void => {
  ipc.handle(whatsNewChannel, (event) =>
    window(event) === undefined ? undefined : whatsNew().catch(() => undefined),
  )
  ipc.on(dismissWhatsNewChannel, (event) => {
    if (window(event) !== undefined) dismiss()
  })
  ipc.on(openWhatsNewPageChannel, (event) => {
    if (window(event) !== undefined) openPage()
  })
}
