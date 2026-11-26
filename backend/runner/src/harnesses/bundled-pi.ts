// Nova's download, in a runner: the pinned pi of @novadeck/harness-nova (its `pin.ts`), fetched
// once into Novadeck's data folder, checked against its pinned checksums, behind its
// Experimental switch, and for the tour whatever the switch says.
import { randomUUID } from "node:crypto"
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { turnOnLine } from "@novadeck/harness-nova/launcher"
import {
  buildFolder,
  buildFor,
  bundledPiFolder,
  bundledPiHome,
  bundledPiProgram,
  ownPiSession,
  pinnedPi,
  type PiBuild,
  type PinnedPi,
} from "@novadeck/harness-nova/pin"
import { seededSettings, settingsFile } from "@novadeck/harness-nova/settings"
import type { AgentName, BundledPiFetch } from "@novadeck/protocol"

import { download, DownloadError, locate } from "../engines/download.js"
import { extract } from "../engines/unpack.js"
import { exists } from "../files.js"

/** What a fetch tells as it goes, a line a person reads. */
export type FetchProgress = (line: string) => void

/** How long a download may go without a byte before it counts as stalled. */
export const stallMs = 30_000

const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1)

/** The line a download in progress shows: `Downloading Pi 1.6.0: 12.3 of 59.0 MB (21%)`. */
export const progressLine = (version: string, received: number, size: number): string =>
  `Downloading Pi ${version}: ${megabytes(received)} of ${megabytes(size)} MB (${Math.floor((received / size) * 100)}%)`

export type FetchOptions = {
  /** Novadeck's data folder. */
  readonly data: string
  /** Whether the person turned Novadeck's pi on (Preferences > Experimental): off, it is refused. */
  readonly enabled: boolean
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly pinned?: PinnedPi
  /**
   * Where the archives are, in place of the release: a folder or an https URL ending in `/`, as
   * tests and builds with a copy of their own name with `NOVADECK_BUNDLED_PI_SOURCE`.
   */
  readonly source?: string | undefined
  /** Where the licence is, in place of its URL. */
  readonly licence?: string | undefined
  readonly progress?: FetchProgress
  /** Hears the bytes the archive's download has so far, of its size, at each whole percent. */
  readonly bytes?: (received: number, size: number) => void
  /** Stops the fetch, which then fails as `stoppedLine` says and leaves nothing. */
  readonly signal?: AbortSignal
  readonly stallMs?: number
}

/** What a fetch stopped by its signal fails with. */
export const stoppedLine = "The download was stopped."

// Renames `from` to `to`, again for a moment on Windows, where an antivirus scanning a file just
// unpacked holds its folder (EPERM, EBUSY, EACCES).
const renameSoon = async (from: string, to: string, platform: NodeJS.Platform): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- One try after another, until one takes.
      return await rename(from, to)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        platform !== "win32" ||
        attempt >= 10 ||
        !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")
      )
        throw error
      // eslint-disable-next-line no-await-in-loop -- Waits out the scan, then tries again.
      await new Promise((settle) => setTimeout(settle, 200))
    }
  }
}

// Unpacks `archive` with the licence beside it, checks it holds the program, and puts it in its
// folder whole: it unpacks beside the folder and is renamed there, so one that is there is whole.
const install = async (
  archive: string,
  licence: string,
  target: string,
  build: PiBuild,
  platform: NodeJS.Platform,
): Promise<void> => {
  const staging = join(target, "..", `.unpacking-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  try {
    await extract(archive, staging, "Could not unpack Pi")
    const program = join(staging, build.program)
    if (!(await exists(program)))
      throw new DownloadError("Pi's archive does not hold Pi for this system.")
    if (platform !== "win32") await chmod(program, 0o755)
    await rename(licence, join(staging, "LICENSE"))
    await rm(target, { recursive: true, force: true })
    await renameSoon(staging, target, platform)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

// `download`, failing as stalled once no byte came for `stall` ms.
const downloadWatched = async (
  options: Omit<Parameters<typeof download>[0], "signal">,
  stall: number,
  signal?: AbortSignal,
): Promise<void> => {
  const controller = new AbortController()
  let timer = setTimeout(() => controller.abort(), stall)
  const stop = () => controller.abort()
  signal?.addEventListener("abort", stop)
  try {
    if (signal?.aborted) throw new DownloadError(stoppedLine)
    await download({
      ...options,
      signal: controller.signal,
      progress: (received) => {
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(), stall)
        options.progress(received)
      },
    })
  } catch (error) {
    if (signal?.aborted) throw new DownloadError(stoppedLine)
    if (controller.signal.aborted)
      throw new DownloadError(
        "The download stalled: no data came for a while. Check the connection.",
      )
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", stop)
  }
}

// The fetch under way for each program, which every launch waiting on it shares, with the
// progress each of them hears.
const underway = new Map<
  string,
  { readonly work: Promise<string>; readonly hearing: Set<FetchProgress> }
>()

/**
 * Novadeck's pi, downloaded once: its program's path, after fetching the pinned build for this
 * system where it isn't in place yet. The licence, then the archive, are checked against their
 * pinned checksums; a download that fails, stalls or comes out wrong leaves nothing, and the
 * next launch fetches again. Builds of other pinned versions are removed once this one is in
 * place, as far as they can be (on Windows a pi still running holds its own); the agent folder
 * stays. Launches waiting at once share one fetch, and each hears its progress from then on. A
 * system pi publishes no build for is refused. The tour can call it ahead of a launch.
 */
export const fetchBundledPi = (options: FetchOptions): Promise<string> => {
  const {
    data,
    platform = process.platform,
    arch = process.arch,
    pinned = pinnedPi,
    progress = () => {},
  } = options
  if (!options.enabled) return Promise.reject(new DownloadError(turnOnLine))
  const build = buildFor(platform, arch, pinned)
  if (!build)
    return Promise.reject(
      new DownloadError(`Pi has no build for this system (${platform}-${arch}).`),
    )
  const program = bundledPiProgram(data, build, pinned.version)
  const running = underway.get(program)
  if (running) {
    progress(`Waiting for Pi ${pinned.version}, which is downloading`)
    running.hearing.add(progress)
    return running.work
  }
  const hearing = new Set<FetchProgress>([progress])
  const say = (line: string) => {
    for (const each of hearing) each(line)
  }
  const work = (async () => {
    if (await exists(program)) return program
    const folder = bundledPiFolder(data)
    const downloads = join(folder, "downloads")
    const archive = join(downloads, build.file)
    const licence = join(downloads, `LICENSE-${pinned.version}`)
    let shown = -1
    try {
      // The licence first, from its own host: where that can't be reached, the archive's 60 MB
      // aren't spent only to be thrown away.
      await downloadWatched(
        {
          from: options.licence || pinned.licence.url,
          to: licence,
          sha256: pinned.licence.sha256,
          size: pinned.licence.size,
          progress: () => {},
        },
        options.stallMs ?? stallMs,
        options.signal,
      )
      await downloadWatched(
        {
          from: locate(options.source || pinned.source, build.file),
          to: archive,
          sha256: build.sha256,
          size: build.size,
          progress: (received) => {
            // A line for each whole percent, not for each chunk.
            const percent = Math.floor((received / build.size) * 100)
            if (percent === shown) return
            shown = percent
            say(progressLine(pinned.version, received, build.size))
            options.bytes?.(received, build.size)
          },
        },
        options.stallMs ?? stallMs,
        options.signal,
      )
      if (options.signal?.aborted) throw new DownloadError(stoppedLine)
      say(`Unpacking Pi ${pinned.version}`)
      const target = buildFolder(data, build, pinned.version)
      await install(archive, licence, target, build, platform)
      // Earlier pinned builds, and what an interrupted unpacking left: what can't go now (a pi
      // still running from it, on Windows) goes on a later fetch.
      for (const entry of await readdir(folder))
        if (entry !== "agent" && entry !== "downloads" && join(folder, entry) !== target)
          // eslint-disable-next-line no-await-in-loop -- A few folders, one after another.
          await rm(join(folder, entry), { recursive: true, force: true }).catch(() => {})
      return program
    } finally {
      await rm(downloads, { recursive: true, force: true })
    }
  })().finally(() => underway.delete(program))
  underway.set(program, { work, hearing })
  return work
}

/**
 * Novadeck's own pi in a runner, behind its Experimental switch (settings' `bundledPi`): on, it
 * is fetched in the background at once, and again as the runner starts while it isn't in place;
 * off, a fetch under way stops, nothing more fetches or starts, and a copy in place is kept.
 * `state` is where the fetch stands, for Preferences' row, each change told to those who `follow`
 * it. `fetch` is the runner's answer to a launcher (`ReportHandlers.fetch`), and what the tour
 * calls ahead of a launch: every fetch at a time is one run, which each caller hears. Archives come
 * from the release, or from where `NOVADECK_BUNDLED_PI_SOURCE` and `NOVADECK_BUNDLED_PI_LICENCE`
 * say, as a test or a build with a copy of its own names them. Any process of the person's can
 * reach the runner's endpoint, which is theirs alone, so a launcher's terminal isn't checked: all
 * it can ask is the pinned, checked download.
 */
export class BundledPi {
  private current: BundledPiFetch = { state: "off" }
  // Who hears each change of the state.
  private readonly hearing = new Set<() => void>()
  // The fetch under way, which every caller shares, and how to stop it.
  private run:
    | {
        readonly work: Promise<string>
        readonly stop: AbortController
        readonly hearing: Set<FetchProgress>
      }
    | undefined
  // A run stopped and not yet settled, which the next waits for, as its files are still going.
  private settling: Promise<void> = Promise.resolve()
  // Whether the tour asked for it (`want`), which the switch going off doesn't undo.
  private wanted = false

  constructor(
    private readonly host: {
      /** Novadeck's data folder. */
      readonly data: string
      /** Whether the switch is on, read live. */
      readonly enabled: () => boolean
      /**
       * Whether the terminal's launcher may start it whatever the switch says: one of the tour's,
       * which the person asked for (`want`). None but the switch's where omitted.
       */
      readonly allows?: (terminalId: string) => boolean
      /**
       * The variables a launcher's Nova in `terminalId` is given: its model service's, a ticket of
       * its own, for one started by hand; none for a terminal that has them already (the tour's).
       * A line said through `progress` tells why where there are none to give. None where omitted.
       */
      readonly service?: (
        terminalId: string,
        progress: FetchProgress,
      ) => Promise<Readonly<Record<string, string>> | undefined>
      /**
       * The file kept while the switch is on, which `nova` reads to start Nova (the shell
       * folder's `bundled/on`); none kept where omitted.
       */
      readonly on?: string
      readonly env?: NodeJS.ProcessEnv
      readonly platform?: NodeJS.Platform
      readonly arch?: string
      readonly pinned?: PinnedPi
    },
  ) {}

  /** Where the fetch stands. */
  state(): BundledPiFetch {
    return this.current
  }

  /** Calls `listener` at each change of the state; the returned function stops it. */
  follow(listener: () => void): () => void {
    this.hearing.add(listener)
    return () => this.hearing.delete(listener)
  }

  /**
   * The switch was set, or the runner started: on, the fetch begins in the background, or the
   * copy in place is ready, and one that failed is tried again, while one under way goes on; off,
   * a fetch under way stops and the state says off.
   */
  switched(): void {
    this.mark()
    // The tour's download goes on, and its state stands, whatever the switch.
    if (this.wanted) return void this.ensure().catch(() => {})
    if (!this.host.enabled()) {
      const { run } = this
      if (run) {
        this.run = undefined
        run.stop.abort()
        this.settling = run.work.then(
          () => {},
          () => {},
        )
      }
      return this.set({ state: "off" })
    }
    void this.ensure().catch(() => {})
  }

  /**
   * Whether `agent`'s session, by its transcript, is this pi's (`ownPiSession`): it resumes on
   * Novadeck's own pi, with no connection of the person's.
   */
  owns(agent: AgentName, transcript: string | undefined): boolean {
    return agent === "pi" && ownPiSession(transcript, this.host.data, this.host.platform)
  }

  /**
   * Fetches Novadeck's `name` (`pi`, Nova) for a launcher in `terminalId`, telling `progress`;
   * refused while switched off, but for a terminal the host allows it in (the tour's). Resolves
   * with the variables its Nova is given (`service`), once its agent folder's settings start a
   * new session on Novadeck's model where they name none of their own (`seededSettings`).
   */
  async fetch(
    name: string,
    progress: FetchProgress,
    terminalId?: string,
  ): Promise<Readonly<Record<string, string>> | undefined> {
    if (name !== "pi") throw new DownloadError(`Novadeck has no ${name} of its own.`)
    const allowed = () =>
      this.host.enabled() || (terminalId !== undefined && this.host.allows?.(terminalId) === true)
    if (!allowed()) throw new DownloadError(turnOnLine)
    // A tour's terminal's ask is the tour's (`want`): the switch going off stops nothing of it.
    if (!this.host.enabled()) this.wanted = true
    try {
      await this.ensure(progress)
    } catch (error) {
      // Switched off meanwhile: the launch is refused as any while off.
      if (!allowed()) throw new DownloadError(turnOnLine)
      throw error
    }
    await this.seed()
    return terminalId === undefined ? undefined : this.host.service?.(terminalId, progress)
  }

  // The file `nova` reads to start Nova, kept as the switch says (the tour's asks aside, as they
  // start Nova by its launcher's path); left where it can't be written, as `nova` then says so.
  private mark(): void {
    const { on } = this.host
    if (on === undefined) return
    const kept = this.host.enabled()
      ? mkdir(join(on, ".."), { recursive: true }).then(() => writeFile(on, ""))
      : rm(on, { force: true })
    void kept.catch(() => {})
  }

  // Nova's agent folder's settings, with Novadeck's model as the one a new session starts on
  // where they name none of their own; left as they are where they can't be read or written,
  // as a session then starts as pi chooses.
  private async seed(): Promise<void> {
    const file = join(bundledPiHome(this.host.data), settingsFile)
    const text = await readFile(file, "utf8").catch(() => undefined)
    const seeded = seededSettings(text)
    if (seeded === undefined) return
    await mkdir(join(file, ".."), { recursive: true })
      .then(() => writeFile(file, seeded))
      .catch(() => {})
  }

  /**
   * The tour asks for it, whatever the switch says, as the person asking for the tour is their
   * consent: the download starts in the background, joins one under way, or tries one that
   * failed again, and its state is told as the switch's is; from then on the switch going off
   * stops nothing. Resolves with its program once in place; rejects with the download's error.
   */
  want(): Promise<string> {
    this.wanted = true
    return this.ensure()
  }

  // The run under way, joined, or a new one.
  private ensure(progress?: FetchProgress): Promise<string> {
    const { run: running } = this
    if (running) {
      if (progress) {
        if (this.current.state === "downloading")
          progress(
            `Waiting for Pi ${this.host.pinned?.version ?? pinnedPi.version}, which is downloading`,
          )
        running.hearing.add(progress)
      }
      return running.work
    }
    const stop = new AbortController()
    const hearing = new Set<FetchProgress>(progress ? [progress] : [])
    const { env = process.env, data, pinned } = this.host
    const platform = this.host.platform ?? process.platform
    const arch = this.host.arch ?? process.arch
    const settling = this.settling
    const mine = () => this.run?.stop === stop
    const work = (async () => {
      await settling
      const build = buildFor(platform, arch, pinned)
      const program = build && bundledPiProgram(data, build, pinned?.version)
      if (mine() && (program === undefined || !(await exists(program))))
        this.set({ state: "downloading", received: 0, ...(build && { size: build.size }) })
      try {
        const done = await fetchBundledPi({
          data,
          enabled: true,
          platform,
          arch,
          ...(pinned !== undefined && { pinned }),
          source: env.NOVADECK_BUNDLED_PI_SOURCE,
          licence: env.NOVADECK_BUNDLED_PI_LICENCE,
          signal: stop.signal,
          progress: (line) => {
            for (const each of hearing) each(line)
          },
          bytes: (received, size) => {
            if (mine()) this.set({ state: "downloading", received, size })
          },
        })
        if (mine()) this.set({ state: "ready" })
        return done
      } catch (error) {
        if (mine())
          this.set({
            state: "failed",
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          })
        throw error
      } finally {
        if (mine()) this.run = undefined
      }
    })()
    this.run = { work, stop, hearing }
    return work
  }

  // Tells a change of the state, and nothing for one that changes nothing, as each launch of a
  // copy in place says ready again.
  private set(state: BundledPiFetch): void {
    if (JSON.stringify(state) === JSON.stringify(this.current)) return
    this.current = state
    for (const listener of this.hearing) listener()
  }
}
