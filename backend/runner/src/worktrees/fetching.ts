import { git, type Run } from "../checkouts/git.js"
import { logs } from "../log.js"
import { homeOf } from "./repo.js"

const log = logs.for("worktrees")

/** How often a repository's remote is fetched at most, in milliseconds. */
export const fetchEveryMs = 5 * 60 * 1000
/** How long one fetch may take before it is given up on. */
export const fetchTimeoutMs = 60 * 1000
/** A repository that keeps failing is tried this seldom at the most. */
const longestWaitMs = 60 * 60 * 1000

/**
 * The variables a fetch runs with so it can never ask the person for anything: no terminal
 * prompt (the runner's git has that off already), no askpass program (a graphical one would
 * open a window), no credential manager dialog, and ssh that fails rather than asks, unless
 * `sshCommand` says the person has their own way.
 */
export const fetchEnv = (person: NodeJS.ProcessEnv, ownSsh: boolean): NodeJS.ProcessEnv => ({
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GCM_INTERACTIVE: "never",
  ...(ownSsh || person.GIT_SSH_COMMAND !== undefined
    ? {}
    : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }),
})

type State = {
  /** When the last fetch succeeded. */
  fetchedAt: number | undefined
  /** Not fetched again before this time. */
  nextAt: number
  failures: number
}

export type FetcherOptions = {
  readonly now?: () => number
  /** The git runner; the runner's own when omitted (a test looks at what it is given). */
  readonly run?: typeof git
  readonly every?: number
  readonly environment?: NodeJS.ProcessEnv
}

/**
 * Brings each tracked repository's `origin` up to date, so a branch merged on the remote reads
 * as merged here. One fetch at a time, each repository at most every five minutes; a failure
 * (offline, no origin, no access) is ignored and the repository waits longer before the next.
 */
export class MainFetcher {
  private readonly states = new Map<string, State>()
  private readonly now: () => number
  private readonly run: typeof git
  private readonly every: number
  private readonly environment: NodeJS.ProcessEnv

  constructor(options: FetcherOptions = {}) {
    this.now = options.now ?? Date.now
    this.run = options.run ?? git
    this.every = options.every ?? fetchEveryMs
    this.environment = options.environment ?? process.env
  }

  /** When the repository was last fetched, or undefined if it never was. */
  fetchedAt(commonDir: string): number | undefined {
    return this.states.get(commonDir)?.fetchedAt
  }

  /** Fetches the repositories that are due, one after another; the rest are forgotten. */
  async fetchDue(commonDirs: Iterable<string>): Promise<void> {
    const wanted = new Set(commonDirs)
    for (const known of this.states.keys()) if (!wanted.has(known)) this.states.delete(known)
    for (const commonDir of wanted) {
      const state = this.states.get(commonDir) ?? { fetchedAt: undefined, nextAt: 0, failures: 0 }
      this.states.set(commonDir, state)
      if (this.now() < state.nextAt) continue
      // eslint-disable-next-line no-await-in-loop -- Never two fetches at once.
      const done = await this.fetch(commonDir)
      const at = this.now()
      if (done.ok) {
        state.fetchedAt = at
        state.failures = 0
        state.nextAt = at + this.every
      } else {
        state.failures += 1
        state.nextAt = at + Math.min(longestWaitMs, this.every * 2 ** state.failures)
        log.debug("worktrees.fetch-failed", "Novadeck could not fetch a repository's origin", {
          data: { commonDir, kind: done.kind, said: done.said },
        })
      }
    }
  }

  private async fetch(
    commonDir: string,
  ): Promise<{ readonly ok: true } | Extract<Run, { ok: false }>> {
    const home = homeOf(commonDir)
    // The person's own ssh command in their git config is theirs to keep.
    const config = await this.run(home, ["config", "--get", "core.sshCommand"], { cap: 4096 })
    const ownSsh = config.ok && config.out.trim() !== ""
    const run = await this.run(home, ["fetch", "--quiet", "--no-tags", "--prune", "origin"], {
      cap: 64 * 1024,
      truncate: true,
      ms: fetchTimeoutMs,
      env: fetchEnv(this.environment, ownSsh),
    })
    return run.ok ? { ok: true } : run
  }
}
