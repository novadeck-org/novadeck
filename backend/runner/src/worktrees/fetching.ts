import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { git, gitScope, type Run } from "../checkouts/git.js"
import { logs } from "../log.js"
import { fastForward, type Forwarded } from "./fast-forward.js"
import { homeOf } from "./repo.js"

const log = logs.for("worktrees")

/** How often a repository's remote is fetched at most, in milliseconds. */
export const fetchEveryMs = 5 * 60 * 1000
/** How long one fetch may take before it is asked to stop (a big repository's first one is slow). */
export const fetchTimeoutMs = 300 * 1000
/** How long git has to stop after that, removing its lock files, before it is killed. */
export const fetchGraceMs = 10 * 1000
/** A repository fetched this recently is not fetched again for a new worktree's base. */
export const recentFetchMs = 60 * 1000
/** A repository that keeps failing is tried this seldom at the most. */
const longestWaitMs = 60 * 60 * 1000

/**
 * The variables a fetch runs with so it can never ask the person for anything: no terminal
 * prompt (the runner's git has that off already), no askpass program (a graphical one would
 * open a window), no credential manager dialog, and ssh that fails rather than asks, unless
 * the person has their own way: `ownSsh` (git's `core.sshCommand`), or `GIT_SSH_COMMAND`,
 * `GIT_SSH` or `GIT_SSH_VARIANT` in the environment. (PuTTY's plink takes no BatchMode, and
 * cannot be made to fail rather than ask here.)
 */
export const fetchEnv = (person: NodeJS.ProcessEnv, ownSsh: boolean): NodeJS.ProcessEnv => ({
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GCM_INTERACTIVE: "never",
  ...(ownSsh ||
  person.GIT_SSH_COMMAND !== undefined ||
  person.GIT_SSH !== undefined ||
  person.GIT_SSH_VARIANT !== undefined
    ? {}
    : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }),
})

type State = {
  /** When the last fetch succeeded. */
  fetchedAt: number | undefined
  /** Not fetched again before this time. */
  nextAt: number
  failures: number
  /** Why the last fetch failed; undefined once one succeeded. */
  failed?: string | undefined
  /** When the fetches began failing: the first failure since the last success. */
  failingSince?: number | undefined
}

export type FetcherOptions = {
  readonly now?: () => number
  /** The git runner; the runner's own when omitted (a test looks at what it is given). */
  readonly run?: typeof git
  readonly every?: number
  readonly environment?: NodeJS.ProcessEnv
  /**
   * The runner's own folder for git's `core.hooksPath` while it moves a checkout, emptied and
   * made owner-only at first use and kept; a private temporary one, removed once no move is
   * under way as the runner closes, when omitted.
   */
  readonly hooksFolder?: string
  /** Whether a fetch is followed by moving the repository's checkout; always, when omitted. */
  readonly follow?: () => boolean
}

/**
 * Brings each tracked repository's `origin` up to date, so a branch merged on the remote reads
 * as merged here, and then moves the repository's own checkout up to its main where that is
 * safe (`fastForward`). One fetch at a time, each repository at most every five minutes; a
 * failure (offline, no origin, no access) is ignored and the repository waits longer before the
 * next.
 */
export class MainFetcher {
  private readonly states = new Map<string, State>()
  private readonly now: () => number
  private readonly run: typeof git
  private readonly every: number
  private readonly environment: NodeJS.ProcessEnv
  private readonly follow: () => boolean
  private readonly hooksFolder: string | undefined
  private readonly ending = new AbortController()
  /** How many times each repository's checkout was moved, by common dir. */
  private readonly moves = new Map<string, number>()
  /** The tail of each repository's checkout moves, by common dir. */
  private readonly forwarding = new Map<string, Promise<void>>()
  /** The empty folder git's hooks are pointed at while a checkout moves; made at first use. */
  private hooks: Promise<string> | undefined
  /** The fetches under way, by repository. */
  private readonly under = new Map<string, Promise<void>>()

  constructor(options: FetcherOptions = {}) {
    this.now = options.now ?? Date.now
    this.run = options.run ?? git
    this.every = options.every ?? fetchEveryMs
    this.environment = options.environment ?? process.env
    this.follow = options.follow ?? (() => true)
    this.hooksFolder = options.hooksFolder
  }

  /** When the repository was last fetched, or undefined if it never was. */
  fetchedAt(commonDir: string): number | undefined {
    return this.states.get(commonDir)?.fetchedAt
  }

  /** Why the repository's last fetch failed, or undefined if it did not (or none was tried). */
  failure(commonDir: string): string | undefined {
    return this.states.get(commonDir)?.failed
  }

  /** When the repository's fetches began failing, or undefined while the last one succeeded. */
  failingSince(commonDir: string): number | undefined {
    return this.states.get(commonDir)?.failingSince
  }

  /** How many times the repository's checkout was moved to its main since the runner began. */
  moved(commonDir: string): number {
    return this.moves.get(commonDir) ?? 0
  }

  /**
   * Moves the repository's checkout to its main now, as the person asked: tracked changes don't
   * hold it back, though git still refuses where one is in the way. Never throws.
   */
  update(commonDir: string): Promise<Forwarded> {
    return this.forward(commonDir, true)
  }

  /** Resolves once no move of a checkout is under way (a test waits for the one a fetch started). */
  async idle(): Promise<void> {
    while (this.forwarding.size > 0) {
      // eslint-disable-next-line no-await-in-loop -- Moves started meanwhile are waited for too.
      await Promise.all(this.forwarding.values())
    }
  }

  /** Ends the fetch under way and starts no more, as the runner closes. */
  abort(): void {
    this.ending.abort()
    // A merge under way is let finish; a folder of the runner's own stays for its next run.
    if (this.hooksFolder === undefined)
      void this.idle()
        .then(() => this.hooks)
        .then(async (dir) => {
          if (dir) await rm(dir, { recursive: true, force: true })
        })
        .catch(() => {})
  }

  // A folder with nothing in it for `core.hooksPath`, which works on Windows where /dev/null
  // doesn't: the runner's own, owner-only, so a repository's hooks can't run in a checkout it
  // moves, and nobody else can put one there. Emptied at first use, whatever was left in it.
  private emptyHooks(): Promise<string> {
    this.hooks ??= (async () => {
      if (this.hooksFolder === undefined) return mkdtemp(join(tmpdir(), "novadeck-no-hooks-"))
      await rm(this.hooksFolder, { recursive: true, force: true })
      await mkdir(this.hooksFolder, { recursive: true, mode: 0o700 })
      return this.hooksFolder
    })()
    return this.hooks
  }

  // One move of a repository's checkout at a time, whoever asks: the person's own Update waits
  // for the one a fetch started, and the other way round.
  private forward(commonDir: string, allowChanges: boolean): Promise<Forwarded> {
    const before = this.forwarding.get(commonDir) ?? Promise.resolve()
    const run = before.then(() => this.forwarded(commonDir, allowChanges))
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.forwarding.set(commonDir, tail)
    void tail.then(() => {
      if (this.forwarding.get(commonDir) === tail) this.forwarding.delete(commonDir)
    })
    return run
  }

  private async forwarded(commonDir: string, allowChanges: boolean): Promise<Forwarded> {
    const home = homeOf(commonDir)
    try {
      const done = await fastForward(home, {
        hooks: () => this.emptyHooks(),
        run: this.run,
        env: fetchEnv(this.environment, true),
        allowChanges,
      })
      if (done.ok && done.moved) this.moves.set(commonDir, this.moved(commonDir) + 1)
      if (!done.ok)
        log.debug("worktrees.checkout-kept", "Novadeck left a repository's own checkout as it is", {
          data: { commonDir, said: done.said },
        })
      return done
    } catch (error) {
      log.debug("worktrees.checkout-failed", "Novadeck could not move a repository's checkout", {
        err: error,
      })
      return { ok: false, said: "Novadeck couldn't update it." }
    }
  }

  /** Fetches the repositories that are due, one after another; the rest are forgotten. */
  async fetchDue(
    commonDirs: Iterable<string>,
    follows: (commonDir: string) => boolean = () => true,
  ): Promise<void> {
    const wanted = new Set(commonDirs)
    for (const [known, state] of this.states)
      // One being fetched, or fetched within the period, is a caller's (a compare's) that has yet to be asked for.
      if (
        !wanted.has(known) &&
        !this.under.has(known) &&
        !(state.fetchedAt !== undefined && this.now() - state.fetchedAt < this.every)
      )
        this.states.delete(known)
    for (const commonDir of wanted) {
      if (this.ending.signal.aborted) return
      const state = this.stateOf(commonDir)
      if (this.now() < state.nextAt) continue
      // eslint-disable-next-line no-await-in-loop -- Never two fetches at once.
      await this.fetching(commonDir, state, false, follows(commonDir))
    }
  }

  /**
   * Fetches the repositories now, due or not, all at once; resolves when each has ended, failed
   * or not. A repository already being fetched is not fetched twice: its fetch is waited for.
   * A failure leaves the repository's own schedule as it was.
   */
  async fetchNow(commonDirs: Iterable<string>): Promise<void> {
    await Promise.all(
      [...new Set(commonDirs)].map((commonDir) =>
        this.fetching(commonDir, this.stateOf(commonDir), true, true),
      ),
    )
  }

  /**
   * Makes the repository's remote main current for a caller that can't wait long (a new
   * worktree's base): nothing is fetched where it was fetched within `recentFetchMs`; otherwise a
   * fetch under way is waited for, or one is started with the usual time limit, and the
   * caller is let go after `ms` either way. The fetch itself is never cut short for the
   * caller: it carries on, as a scheduled one would. The repository's checkout follows the fetch
   * only if `follow`. Never throws.
   */
  async fetchBriefly(commonDir: string, ms: number, follow = true): Promise<void> {
    const state = this.stateOf(commonDir)
    if (
      !this.under.has(commonDir) &&
      state.fetchedAt !== undefined &&
      this.now() - state.fetchedAt < recentFetchMs
    )
      return
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    })
    try {
      await Promise.race([this.fetching(commonDir, state, true, follow), late])
    } finally {
      clearTimeout(timer)
    }
  }

  private stateOf(commonDir: string): State {
    const state = this.states.get(commonDir) ?? { fetchedAt: undefined, nextAt: 0, failures: 0 }
    this.states.set(commonDir, state)
    return state
  }

  // One fetch of a repository, shared by whoever asks while it is under way.
  private fetching(
    commonDir: string,
    state: State,
    asked: boolean,
    follow: boolean,
  ): Promise<void> {
    const under = this.under.get(commonDir)
    if (under) return under
    const run = (async () => {
      if (this.ending.signal.aborted) return
      const done = await gitScope.run(this.ending.signal, () => this.fetch(commonDir, follow))
      if (this.ending.signal.aborted) return
      const at = this.now()
      if (done.ok) {
        state.fetchedAt = at
        state.failed = undefined
        state.failingSince = undefined
        state.failures = 0
        state.nextAt = at + this.every
      } else {
        if (!asked) {
          state.failures += 1
          state.nextAt = at + Math.min(longestWaitMs, this.every * 2 ** state.failures)
        }
        state.failed = done.kind === "timeout" ? "git took too long" : done.said || "git failed"
        state.failingSince ??= at
        log.debug("worktrees.fetch-failed", "Novadeck could not fetch a repository's origin", {
          data: { commonDir, kind: done.kind, said: done.said },
        })
      }
    })().finally(() => this.under.delete(commonDir))
    this.under.set(commonDir, run)
    return run
  }

  /** What a git run that reaches the repository's origin runs with: see `fetchEnv`. */
  private async remoteEnv(home: string): Promise<NodeJS.ProcessEnv> {
    // The person's own ssh command in their git config is theirs to keep.
    const config = await this.run(home, ["config", "--get", "core.sshCommand"], { cap: 4096 })
    return fetchEnv(this.environment, config.ok && config.out.trim() !== "")
  }

  /**
   * Whether origin has the branch now, asked of origin itself (`git ls-remote`), as no fetch here
   * prunes a branch deleted there: true or false, undefined where origin couldn't be asked within
   * `ms` (offline, no access, no origin). Never throws.
   */
  async remoteHas(commonDir: string, branch: string, ms: number): Promise<boolean | undefined> {
    if (this.ending.signal.aborted) return undefined
    try {
      const home = homeOf(commonDir)
      const env = await this.remoteEnv(home)
      const run = await gitScope.run(this.ending.signal, () =>
        this.run(home, ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], {
          cap: 64 * 1024,
          ms,
          env,
        }),
      )
      if (run.ok) return true
      // Exit 2 is ls-remote's own answer that origin has no such ref.
      return run.kind === "exit" && run.status === 2 ? false : undefined
    } catch {
      return undefined
    }
  }

  private async fetch(
    commonDir: string,
    follow: boolean,
  ): Promise<{ readonly ok: true } | Extract<Run, { ok: false }>> {
    const home = homeOf(commonDir)
    const env = await this.remoteEnv(home)
    // Nothing in the person's repository changes but `refs/remotes/origin/*`: no FETCH_HEAD,
    // no pruning of refs, no background maintenance or commit-graph.
    const run = await this.run(
      home,
      [
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        "-c",
        "fetch.writeCommitGraph=false",
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "origin",
      ],
      {
        cap: 64 * 1024,
        truncate: true,
        ms: fetchTimeoutMs,
        graceMs: fetchGraceMs,
        env,
      },
    )
    if (!run.ok) return run
    // The fetch moved only `origin/*`; the checkout follows where it is safe to.
    // Not waited for: a merge that hangs (a filter, a stalled disk) must not stall fetching.
    if (follow && this.follow()) void this.forward(commonDir, false)
    return { ok: true }
  }
}
