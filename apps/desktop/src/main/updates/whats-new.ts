import { parseWhatsNew, updateVersionPattern, type WhatsNew } from "@novadeck/protocol/bridge"
import { readNotesBlock, type ReleaseNotes } from "@novadeck/protocol/release-notes"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import { dismissWhatsNewChannel, whatsNewChannel } from "../../bridge.js"
import type { ReleaseRepository } from "../release/repository.js"

/** How long reading the release waits; the card is optional, so a slow network gives it up. */
export const releaseReadMs = 10_000
/** How long a read that failed for a reason that may pass waits before its one more try. */
export const readRetryMs = 2 * 60 * 1000
/** How long a prerelease without highlights waits before its release is read again. */
export const prereleaseRecheckMs = 24 * 60 * 60 * 1000

/**
 * What a launch records and whether it leaves the notes of this version to show. Only an
 * update shows them: a previous launch as an older version. A first launch, the same
 * version again and a downgrade show nothing, and notes pending for another version are
 * given up, as the person has moved on from it. A build that is no release's, such as a
 * development run or a pull request build carrying 0.0.0, or one without a release
 * repository to read from (`offerable` false), changes nothing, so it never stands for the
 * version an update is measured from. `from` is the version the notes to show start after:
 * the one updated from, or the newest settled when that is newer, so builds skipped on the
 * way are told too; it is kept with the mark. `newer` tells whether its first version is
 * newer than its second.
 */
export const whatsNewAtLaunch = (
  {
    previous,
    current,
    pending,
    from,
    settled,
    ranBefore,
    offerable,
  }: {
    readonly previous: string | undefined
    readonly current: string
    readonly pending: string | undefined
    /** Where the notes of the version pending start; see `UpdateState`. */
    readonly from: string | undefined
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
):
  | {
      readonly lastRunVersion: string
      readonly pending: string | undefined
      readonly from: string | undefined
    }
  | undefined => {
  if (!offerable || current === "0.0.0" || !updateVersionPattern.test(current)) return undefined
  const updated = previous === undefined ? ranBefore : newer(current, previous)
  // A version at or below one settled is never offered, whatever else says it was updated.
  const unsettled = settled === undefined || newer(current, settled)
  const marked = unsettled && (updated || pending === current) ? current : undefined
  // Notes of another version still pending were not seen, so they are told with these: the
  // notes start where its did, or after the version updated from when that is not known.
  const unseen =
    pending !== undefined &&
    pending !== current &&
    (settled === undefined || newer(pending, settled))
  const start = pending === current ? from : unseen ? (from ?? previous) : previous
  // Notes at or below a settled version were seen, or had nothing to see.
  const since =
    settled !== undefined && (start === undefined || newer(settled, start)) ? settled : start
  return {
    lastRunVersion: current,
    pending: marked,
    from: marked === undefined ? undefined : pending === current ? from : since,
  }
}

/** A release as read: whether it is a prerelease, and its notes when they are its own. */
type Release = {
  readonly version: string
  readonly prerelease: boolean
  readonly notes: ReleaseNotes | undefined
}

/** A release as GitHub answers it, or undefined for an answer that is not one. */
const releaseOf = (answer: unknown): Release | undefined => {
  if (typeof answer !== "object" || answer === null) return undefined
  const { tag_name: tag, body, prerelease } = answer as Record<string, unknown>
  if (typeof tag !== "string" || !tag.startsWith("v")) return undefined
  if (typeof body !== "string" && body !== null) return undefined
  const version = tag.slice(1)
  const block = typeof body === "string" ? readNotesBlock(body) : undefined
  // A block that names another version, as a body copied from an earlier release would
  // carry, is not this release's notes. It is read as no block.
  return {
    version,
    prerelease: prerelease === true,
    notes: block?.version === version ? block : undefined,
  }
}

const headers = { Accept: "application/vnd.github+json", "User-Agent": "Novadeck" }

// Reads the release of `version`: the release, none ever, or none for now.
const readRelease = async (
  fetch: ReleaseFetch,
  { owner, repo }: ReleaseRepository,
  version: string,
): Promise<Release | "none" | "later"> => {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/v${version}`,
    { headers, signal: AbortSignal.timeout(releaseReadMs) },
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
  // Only the release itself settles anything: an empty or odd answer that is not this
  // release, as a proxy's JSON would be, passes.
  const release = releaseOf(await response.json())
  return release?.version === version ? release : "later"
}

/** How many releases a page of the list holds, and how many pages are read at most. */
export const releasesPerPage = 100
export const releasePages = 3

// Reads the releases after `from` and before `version`, newest first, or none for now. The
// list comes newest first, so it is read until a page reaches `from`; a person who skipped
// more builds than the pages hold is told of the newest of them.
const readSkipped = async (
  fetch: ReleaseFetch,
  { owner, repo }: ReleaseRepository,
  from: string,
  version: string,
  newer: (a: string, b: string) => boolean,
): Promise<Release[] | "later"> => {
  const found: Release[] = []
  for (let page = 1; page <= releasePages; page += 1) {
    // eslint-disable-next-line no-await-in-loop -- Each page decides whether the next is read.
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${releasesPerPage}&page=${page}`,
      { headers, signal: AbortSignal.timeout(releaseReadMs) },
    )
    if (!response.ok) return "later"
    // eslint-disable-next-line no-await-in-loop -- As above.
    const answer: unknown = await response.json()
    // A proxy's answer is no list: it passes.
    if (!Array.isArray(answer)) return "later"
    const releases = answer.flatMap((item: unknown) => {
      const release = releaseOf(item)
      return release && updateVersionPattern.test(release.version) ? [release] : []
    })
    found.push(
      ...releases.filter(
        (release) => newer(release.version, from) && newer(version, release.version),
      ),
    )
    if (
      answer.length < releasesPerPage ||
      releases.some((release) => !newer(release.version, from))
    )
      break
  }
  return found.toSorted((a, b) => (newer(a.version, b.version) ? -1 : 1))
}

/**
 * The highlights of `version` and of the releases skipped on the way to it, newest first.
 * A promotion's notes tell every change since the stable release before it, so the notes of
 * a release older than a promotion, with no stable release between, are left out: that
 * promotion tells them better. A stable release whose notes are not a promotion's, as when
 * writing them failed, still bounds the promotion after it. A highlight two releases share
 * is told once. `from` is the version they are new since, when the launch knows one.
 */
const gather = (
  version: string,
  from: string | undefined,
  releases: readonly Release[],
  newer: (a: string, b: string) => boolean,
): WhatsNew | undefined => {
  const promotions = releases.filter((release) => release.notes?.kind === "promote")
  const stable = releases.filter((release) => !release.prerelease)
  const covered = (release: Release): boolean =>
    promotions.some(
      (promotion) =>
        newer(promotion.version, release.version) &&
        !stable.some(
          (bound) =>
            !newer(release.version, bound.version) && newer(promotion.version, bound.version),
        ),
    )
  const told = releases.filter((release) => release.notes?.kind === "promote" || !covered(release))
  const seen = new Set<string>()
  const highlights = told
    .flatMap((release) => release.notes?.highlights ?? [])
    .flatMap(({ title, line, icon }) => {
      const key = `${title}\n${line}`
      if (seen.has(key)) return []
      seen.add(key)
      return [icon ? { title, line, icon } : { title, line }]
    })
  return parseWhatsNew({ version, from, highlights })
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
 * What is new in the version this launch runs, while `pending` names it: the highlights of
 * its release and of the releases skipped since `from`, newest first, with `from` for the
 * card to name (see `gather`). The releases are read once per launch, the first time it is
 * asked for, and the answer kept. When they are read and have no highlights, or the
 * version's release does not exist, there is nothing to show ever, so the pending mark is
 * cleared. A failure to read it, offline, timed out, rate limited or a server error, is
 * tried once more `readRetryMs` later, and when that fails too the mark is left for a later
 * launch and nothing is shown.
 * Nothing is thrown: the card is a courtesy, and `log` hears of what went wrong.
 * `repository` is where the build's releases are, or undefined for a build without one.
 */
export const keepWhatsNew = ({
  version,
  launched,
  pending,
  from,
  clear,
  checkedAt,
  recordCheck,
  now,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  repository,
  fetch,
  newer,
  log,
}: {
  readonly version: string
  /** Settles when the launch has recorded what it learned, which decides `pending`. */
  readonly launched: () => Promise<void>
  readonly pending: () => string | undefined
  /** The version the notes to show start after, if the launch knows one; see `whatsNewAtLaunch`. */
  readonly from: () => string | undefined
  readonly clear: () => void
  /** When a prerelease without highlights was last read, if it was. */
  readonly checkedAt: () => number | undefined
  readonly recordCheck: (time: number) => void
  readonly now: () => number
  /** Waits `ms`; a timer by default. */
  readonly delay?: (ms: number) => Promise<void>
  readonly repository: () => Promise<ReleaseRepository | undefined>
  readonly fetch: ReleaseFetch
  /** Whether the first version is newer than the second. */
  readonly newer: (a: string, b: string) => boolean
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
  // One read: the highlights, nothing to show, or `retry` for a failure that may pass.
  const attempt = async (): Promise<WhatsNew | "retry" | undefined> => {
    try {
      const source = await repository()
      if (source === undefined) return undefined
      const own = await readRelease(fetch, source, version)
      if (own === "later") return "retry"
      if (own === "none") {
        forget()
        return undefined
      }
      // A prerelease whose notes are not written yet is waited for, not told without them.
      if (own.prerelease && own.notes === undefined) {
        recordCheck(now())
        return undefined
      }
      const start = from()
      const skipped =
        start === undefined ? [] : await readSkipped(fetch, source, start, version, newer)
      if (skipped === "later") return "retry"
      const shown = gather(version, start, [own, ...skipped], newer)
      if (shown) return shown
      // A prerelease with no highlights may get some yet: promoting it writes them onto
      // this same tag before it turns stable, so an experimental user who installed it is shown
      // them then.
      if (own.prerelease) recordCheck(now())
      else forget()
    } catch (error) {
      log("The release notes were not read.", error)
      return "retry"
    }
    return undefined
  }
  // A failure that may pass is tried once more a couple of minutes on, in the same launch.
  // The page asks once, so its answer waits for that, which a page does not mind: the card
  // is not what it waits on. A dismissal meanwhile ends it.
  const read = async (): Promise<WhatsNew | undefined> => {
    const first = await attempt()
    if (first !== "retry") return first
    await delay(readRetryMs)
    if (pending() !== version) return undefined
    const second = await attempt()
    return second === "retry" ? undefined : second
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

/**
 * What is new in the version a copy that cannot install it is offered: the highlights of
 * `offered` and of the releases between this copy's `version` and it, newest first, as
 * `keepWhatsNew` tells them after an update, with `from` this version. Undefined when there
 * is no offer, when none of the releases names highlights, and when they can't be read;
 * nothing is thrown. A read is kept for the version it was made for, except one that failed
 * for a reason that may pass, or found a prerelease whose notes are not written yet, which
 * are tried again at the next ask.
 */
export const keepUpdateNews = ({
  version,
  offered,
  repository,
  fetch,
  newer,
  log,
}: {
  /** This build's version. */
  readonly version: string
  /** The version the last update offer names, if there is one. */
  readonly offered: () => string | undefined
  readonly repository: () => Promise<ReleaseRepository | undefined>
  readonly fetch: ReleaseFetch
  /** Whether the first version is newer than the second. */
  readonly newer: (a: string, b: string) => boolean
  readonly log: (message: string, error: unknown) => void
}): (() => Promise<WhatsNew | undefined>) => {
  const kept = new Map<string, WhatsNew | undefined>()
  const read = async (target: string): Promise<WhatsNew | undefined | "later"> => {
    try {
      const source = await repository()
      if (source === undefined) return undefined
      const own = await readRelease(fetch, source, target)
      if (own === "later") return "later"
      if (own === "none") return undefined
      const skipped = await readSkipped(fetch, source, version, target, newer)
      if (skipped === "later") return "later"
      const news = gather(target, version, [own, ...skipped], newer)
      // A prerelease whose notes are not written yet gets them when it is promoted.
      return news === undefined && own.prerelease && own.notes === undefined ? "later" : news
    } catch (error) {
      log("The release notes of the offered version were not read.", error)
      return "later"
    }
  }
  return async () => {
    const target = offered()
    if (target === undefined || !newer(target, version)) return undefined
    if (kept.has(target)) return kept.get(target)
    const news = await read(target)
    if (news === "later") return undefined
    kept.set(target, news)
    return news
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
 * Answers the app's own pages: the request for what is new, and its dismissal. `window`
 * names the window of a request from the main frame of the app's own page, or undefined for
 * any other sender, which is ignored (and told there is nothing new). The page names no
 * version or address.
 */
export const registerWhatsNewIpc = <Window>(
  ipc: WhatsNewIpc,
  {
    window,
    whatsNew,
    dismiss,
  }: {
    readonly window: (event: IpcMainEvent | IpcMainInvokeEvent) => Window | undefined
    readonly whatsNew: () => Promise<WhatsNew | undefined>
    readonly dismiss: () => void
  },
): void => {
  ipc.handle(whatsNewChannel, (event) =>
    window(event) === undefined ? undefined : whatsNew().catch(() => undefined),
  )
  ipc.on(dismissWhatsNewChannel, (event) => {
    if (window(event) !== undefined) dismiss()
  })
}
