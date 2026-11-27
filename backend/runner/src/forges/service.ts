import {
  forges as libraryForges,
  isProblem,
  parseRemote,
  type Fetch,
  type Forge,
  type Problem,
  type PullRequest,
  type Remote,
  type Repository,
  type Run,
  type Token,
} from "@novadeck/forges"
import {
  forgeLimits,
  forgeName,
  type ForgeHost,
  type ForgeIntegration,
  type ForgeName,
} from "@novadeck/protocol"

import { git } from "../checkouts/git.js"
import { logs } from "../log.js"
import { findProgram } from "../programs.js"
import { homeOf } from "../worktrees/repo.js"
import { installerFor } from "./installers.js"
import { createRun } from "./run.js"

const log = logs.for("forges")

/** A repository's pull requests are looked up at most this often, in milliseconds. */
export const lookEveryMs = 5 * 60 * 1000
/** A repository with an open pull request whose checks are running is looked up this often. */
export const lookWhileRunningMs = 60 * 1000
/** The quick look stops after this long without a pull request's checks changing. */
export const quickLookForMs = 30 * 60 * 1000
/** A repository that keeps failing is tried this seldom at the most. */
const longestWaitMs = 60 * 60 * 1000
/** A token this close to its end is asked for again. */
const marginMs = 30 * 1000
/** The least a rate limit is waited out, whatever time it names. */
const minimumLimitedMs = 60 * 1000
/** How long one lookup of the forge's API may take. */
const fetchTimeoutMs = 30 * 1000

/** A repository Novadeck tracks worktrees of, with what its lookup is asked and watches. */
export type RepositoryFacts = {
  /** Its git common dir. */
  readonly commonDir: string
  /** The branches of its worktrees. */
  readonly branches: readonly string[]
  /** When its origin was last fetched, where it was. */
  readonly fetchedAt: number | undefined
}

export type ForgesOptions = {
  /** The forges switched on (the runner gives every one), and saving them; nothing runs for one that is off. */
  readonly enabled: () => readonly ForgeName[]
  readonly save: (forges: readonly ForgeName[]) => void
  /** The repositories of the worktrees Novadeck tracks. */
  readonly repositories: () => readonly RepositoryFacts[]
  /** Whether the works are being watched: nothing is looked up otherwise. */
  readonly watching: () => boolean
  /** The person's login environment, which finds each forge's tool. */
  readonly environment: () => NodeJS.ProcessEnv
  /** Reads the login environment again (it spawns the person's shell), for a fresh list. */
  readonly refreshEnvironment?: () => Promise<void>
  /** The forges; the library's by default (a test gives fakes). */
  readonly forges?: Readonly<Record<ForgeName, Forge>>
  /** How a forge's tool is run; on `environment`, by default. */
  readonly run?: Run
  readonly fetch?: Fetch
  /** Where a program is, by its absolute path; its PATH's, by default. */
  readonly find?: (program: string) => string | undefined
  /** A repository's origin URL, its `insteadOf` rewrites applied; `git remote get-url origin`, by default. */
  readonly remote?: (commonDir: string) => Promise<string | undefined>
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  /** Told when a watched pull request of a repository turned merged since the last look. */
  readonly merged?: (commonDir: string) => void
  /** How often a repository is looked up at most. */
  readonly every?: number
  /** How often the repositories are checked for being due, while the service runs. */
  readonly tickMs?: number
}

// What was last found of a repository: its forge, when to look again, and the pull requests.
type Look = {
  readonly forge: ForgeName
  /** The look is due again then. */
  nextAt: number
  /** A failure holds the look until then, whatever else changed. */
  blockedUntil: number
  failures: number
  /** What the look was of: the origin's fetch time and the branches asked. */
  fetchedAt: number | undefined
  branches: string
  requests: ReadonlyMap<string, PullRequest>
  /** Since when checks have been running with the same standings, for the quick look's cap. */
  quick?: { readonly since: number; readonly standing: string } | undefined
}

const order = forgeName.options

/**
 * The forges switched on (every one, as the runner has them): each tracked repository's branches asked of its forge's
 * API, with a token the forge's own signed-in tool gives, while the works are watched. What is
 * found is kept in memory (`pullRequest`); nothing of a token is stored or logged.
 */
export class Forges {
  private readonly forges: Readonly<Record<ForgeName, Forge>>
  private readonly run: Run
  private readonly fetch: Fetch
  private readonly find: (program: string) => string | undefined
  private readonly platform: NodeJS.Platform
  private readonly now: () => number
  private readonly every: number
  private readonly ending = new AbortController()
  /** What was last found, by repository. */
  private readonly looks = new Map<string, Look>()
  /** Tokens, by forge and host; only in memory. */
  private readonly held = new Map<string, Token>()
  private readonly asking = new Map<string, Promise<Token | Problem>>()
  /**
   * The token each host last turned away, by forge and host; only in memory. The tool handing
   * out that same token again says nothing new of the sign-in.
   */
  private readonly turnedAway = new Map<string, string>()
  /** Where each host stands, from the last token attempt or lookup. */
  private readonly hosts = new Map<string, ForgeHost>()
  /** Origin remotes by repository, and when each was read: read again every `every`. */
  private readonly remotes = new Map<
    string,
    { readonly at: number; readonly found: Promise<Remote | undefined> }
  >()
  /** The hosts each forge's tool is signed in to, and when that was asked. */
  private readonly signed = new Map<ForgeName, { at: number; hosts: Promise<readonly string[]> }>()
  private running: Promise<void> | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly options: ForgesOptions) {
    this.forges = options.forges ?? libraryForges
    this.run = options.run ?? createRun({ environment: options.environment })
    this.platform = options.platform ?? process.platform
    this.fetch =
      options.fetch ??
      ((input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            this.ending.signal,
            AbortSignal.timeout(fetchTimeoutMs),
          ]),
        }))
    this.find = options.find ?? ((program) => findProgram(program, { env: options.environment() }))
    this.now = options.now ?? Date.now
    this.every = options.every ?? lookEveryMs
  }

  private merged(commonDir: string): void {
    try {
      this.options.merged?.(commonDir)
    } catch (error) {
      log.warn("forges.merged-failed", "Novadeck could not follow a merged pull request", {
        err: error,
      })
    }
  }

  /** Starts looking at the repositories every `tickMs` (5 s by default). */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 5_000)
    this.timer.unref()
  }

  /** Ends what is under way and looks no more. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.ending.abort()
    await this.running?.catch(() => {})
  }

  /** The pull request of a branch in a repository, where a forge switched on found one. */
  pullRequest(commonDir: string, branch: string): PullRequest | undefined {
    const look = this.looks.get(commonDir)
    if (!look || !this.options.enabled().includes(look.forge)) return undefined
    return look.requests.get(branch)
  }

  /**
   * Where each forge stands; `fresh` reads the environment, remotes and sign-ins again, and
   * `cached` asks no tool and reads no remote, answering with the hosts already known.
   */
  async list(look?: {
    readonly fresh?: boolean | undefined
    readonly cached?: boolean | undefined
  }): Promise<ForgeIntegration[]> {
    if (look?.cached === true && look.fresh !== true) return order.map((name) => this.known(name))
    if (look?.fresh === true) {
      await this.options.refreshEnvironment?.().catch((error: unknown) =>
        log.warn("forges.environment-failed", "Novadeck could not read its environment", {
          err: error,
        }),
      )
      this.remotes.clear()
      this.signed.clear()
      // Each tool is asked again. Where each host stood stays, so a token the host turned away
      // is not taken for a sign-in; a host signed out or refused is asked again below.
      this.held.clear()
      // A sign-in or an install since may mend what backed off: look again, keeping what was
      // found meanwhile, so the marks don't blink.
      for (const each of this.looks.values()) each.nextAt = each.blockedUntil = each.failures = 0
      void this.tick()
    }
    const enabled = this.options.enabled()
    const among = order.filter((name) => enabled.includes(name) && this.installed(name))
    const claims = among.length === 0 ? [] : await this.claims(among)
    return Promise.all(
      order.map((name) =>
        this.integration(
          name,
          enabled.includes(name),
          claims.flatMap((claim) => (claim.forge === name ? [claim.host] : [])),
        ),
      ),
    )
  }

  /** Switches a forge on or off; one switched on is looked at for its repositories at once. */
  async set(name: ForgeName, enabled: boolean): Promise<ForgeIntegration> {
    const now = this.options.enabled()
    const next = order.filter((each) => (each === name ? enabled : now.includes(each)))
    this.options.save(next)
    // An older client can ask to turn an always-on forge off; what it found stands.
    const on = this.options.enabled().includes(name)
    if (now.includes(name) !== on) this.forget(name)
    if (on && enabled) void this.tick()
    return (await this.list()).find((each) => each.forge === name)!
  }

  /** One check of the repositories: those due are looked up, one after another. */
  tick(): Promise<void> {
    this.running ??= this.pass()
      .catch((error: unknown) =>
        log.error("forges.pass-failed", "Looking up pull requests failed", {
          err: error,
        }),
      )
      .finally(() => {
        this.running = undefined
      })
    return this.running
  }

  private installed(name: ForgeName): boolean {
    return this.find(this.forges[name].program) !== undefined
  }

  // What a forge's switching off or on leaves behind: its looks, tokens and hosts.
  private forget(name: ForgeName): void {
    for (const [dir, look] of this.looks) if (look.forge === name) this.looks.delete(dir)
    for (const key of [...this.held.keys(), ...this.hosts.keys(), ...this.turnedAway.keys()])
      if (key.startsWith(`${name}\0`)) {
        this.held.delete(key)
        this.hosts.delete(key)
        this.turnedAway.delete(key)
      }
    this.signed.delete(name)
  }

  // Where a forge stands by what is already known: its hosts as last found, no tool asked.
  private known(name: ForgeName): ForgeIntegration {
    const enabled = this.options.enabled().includes(name)
    const available = this.installed(name)
    const installer = available
      ? undefined
      : installerFor(name, this.platform, this.find("brew") !== undefined)
    const hosts =
      enabled && available
        ? [...this.hosts]
            .flatMap(([key, host]) => (key.startsWith(`${name}\0`) ? [host] : []))
            .slice(0, forgeLimits.hosts)
        : []
    return { forge: name, available, enabled, ...(installer && { installer }), hosts }
  }

  private async integration(
    name: ForgeName,
    enabled: boolean,
    claimed: readonly string[],
  ): Promise<ForgeIntegration> {
    const forge = this.forges[name]
    const available = this.installed(name)
    const installer = available
      ? undefined
      : installerFor(name, this.platform, this.find("brew") !== undefined)
    const hosts: ForgeHost[] = []
    if (enabled && available) {
      const wanted = (claimed.length > 0 ? [...new Set(claimed)] : [forge.defaultHost]).slice(
        0,
        forgeLimits.hosts,
      )
      await Promise.all(
        wanted.map((host) => {
          const key = hostKey(name, host)
          const state = this.hosts.get(key)?.state
          if (state === undefined) return this.tokenOf(name, host)
          // Signed in or mended since, maybe in the person's own terminal: the tool is asked
          // again, and a token other than the one turned away counts as signed in.
          if (state === "signed-out" || state === "refused") {
            this.held.delete(key)
            return this.tokenOf(name, host)
          }
          return undefined
        }),
      )
      for (const host of wanted) {
        const state = this.hosts.get(hostKey(name, host))
        if (state) hosts.push(state)
      }
    }
    return {
      forge: name,
      available,
      enabled,
      ...(installer && { installer }),
      hosts,
    }
  }

  private async pass(): Promise<void> {
    if (!this.options.watching() || this.ending.signal.aborted) return
    const enabled = this.options.enabled()
    const among = order.filter((name) => enabled.includes(name) && this.installed(name))
    const facts = this.options.repositories()
    const known = new Set(facts.map((each) => each.commonDir))
    for (const [dir, look] of this.looks)
      if (!known.has(dir) || !among.includes(look.forge)) this.looks.delete(dir)
    for (const dir of this.remotes.keys()) if (!known.has(dir)) this.remotes.delete(dir)
    if (among.length === 0) return
    for (const repository of facts) {
      if (this.ending.signal.aborted) return
      if (among.every((name) => !this.options.enabled().includes(name))) return
      const branches = [...new Set(repository.branches)].toSorted()
      if (branches.length === 0) continue
      // eslint-disable-next-line no-await-in-loop -- One repository at a time.
      const claim = await this.claim(repository.commonDir, among)
      if (!claim) {
        this.looks.delete(repository.commonDir)
        continue
      }
      const before = this.looks.get(repository.commonDir)
      const look =
        before?.forge === claim.forge
          ? before
          : {
              forge: claim.forge,
              nextAt: 0,
              blockedUntil: 0,
              failures: 0,
              fetchedAt: undefined,
              branches: "",
              requests: new Map<string, PullRequest>(),
            }
      // Switched off since the pass began: nothing is looked up or kept for it.
      if (!this.options.enabled().includes(claim.forge)) continue
      this.looks.set(repository.commonDir, look)
      const now = this.now()
      const signature = branches.join("\0")
      const changed = look.fetchedAt !== repository.fetchedAt || look.branches !== signature
      if (
        before?.forge === look.forge &&
        now < look.nextAt &&
        !(changed && now >= look.blockedUntil)
      )
        continue
      // eslint-disable-next-line no-await-in-loop -- One repository at a time.
      await this.look(repository, look, claim, branches, signature)
    }
  }

  // Asks one repository's forge, and schedules the next look by what it answered.
  private async look(
    repository: RepositoryFacts,
    look: Look,
    claim: Repository,
    branches: readonly string[],
    signature: string,
  ): Promise<void> {
    const found = await this.lookup(claim, branches)
    if (this.ending.signal.aborted) return
    // Switched off while it was asked: what it found, and the tokens, are dropped.
    if (!this.options.enabled().includes(claim.forge)) return this.forget(claim.forge)
    const at = this.now()
    look.fetchedAt = repository.fetchedAt
    look.branches = signature
    if (!isProblem(found)) {
      const was = look.requests
      look.requests = found
      look.failures = 0
      look.blockedUntil = 0
      // Checks still running are looked at again sooner, to see them end, but not for ever: a
      // check that never reports (a required one nobody runs) is left to the slow look once
      // 30 minutes have passed with no pull request's checks changing.
      const running = [...found.values()].some((pull) => pull.ci === "running")
      const standing = [...found].map(([branch, pull]) => `${branch}:${pull.ci}`).join("\0")
      if (!running) look.quick = undefined
      else if (look.quick?.standing !== standing) look.quick = { since: at, standing }
      const quick = running && at - (look.quick?.since ?? at) < quickLookForMs
      look.nextAt = at + (quick ? Math.min(this.every, lookWhileRunningMs) : this.every)
      // A pull request seen open (or draft) that is merged now: main has moved on its origin.
      if (
        [...found].some(
          ([branch, pull]) =>
            pull.state === "merged" &&
            was.get(branch)?.state !== undefined &&
            was.get(branch)?.state !== "merged",
        )
      )
        this.merged(repository.commonDir)
      return
    }
    // What was found before stands: it is never told "no pull request" for a failed lookup.
    if (found.kind === "limited")
      // A reset time already past (a stale header, a skewed clock) still waits a minute.
      look.nextAt = look.blockedUntil = Math.max(found.until, at + minimumLimitedMs)
    else if (found.kind === "missing") look.nextAt = look.blockedUntil = at + this.every
    else {
      look.failures += 1
      look.nextAt = look.blockedUntil =
        at + Math.min(longestWaitMs, this.every * 2 ** look.failures)
    }
    log.debug("forges.look-failed", "Novadeck could not look up pull requests", {
      data: {
        forge: claim.forge,
        host: claim.host,
        kind: found.kind,
        ...(found.kind === "unknown" && { said: found.said.slice(0, 500) }),
      },
    })
  }

  // The branches' pull requests, with a token; a refused one is dropped and asked for once more.
  private async lookup(
    claim: Repository,
    branches: readonly string[],
  ): Promise<ReadonlyMap<string, PullRequest> | Problem> {
    const forge = this.forges[claim.forge]
    const key = hostKey(claim.forge, claim.host)
    type Asked = {
      readonly found: ReadonlyMap<string, PullRequest> | Problem
      /** The token the forge was asked with; absent where the tool gave none. */
      readonly token?: Token
    }
    const ask = async (): Promise<Asked> => {
      const token = await this.tokenOf(claim.forge, claim.host)
      if (isProblem(token)) return { found: token }
      try {
        return { found: await forge.pullRequests(this.fetch, token, claim, branches), token }
      } catch (error) {
        const said = error instanceof Error ? error.message : String(error)
        return { found: { kind: "unknown", said }, token }
      }
    }
    // The host turned the token away (revoked, rotated, another tenant's: a 401 or a refusal).
    const turnedAway = (asked: Asked): boolean => {
      if (asked.token === undefined || !isProblem(asked.found)) return false
      if (asked.found.kind !== "refused" && asked.found.kind !== "signed-out") return false
      if (this.options.enabled().includes(claim.forge)) this.turnedAway.set(key, asked.token.value)
      return true
    }
    let asked = await ask()
    // A token turned away is dropped and asked for once more; a tool that gives none (it is
    // signed out) isn't asked twice.
    if (turnedAway(asked)) {
      this.held.delete(key)
      asked = await ask()
      turnedAway(asked)
    }
    const { found } = asked
    if (isProblem(found)) {
      if (found.kind === "refused" || found.kind === "signed-out")
        this.noteHost(claim.forge, claim.host, found)
    } else if (this.options.enabled().includes(claim.forge)) {
      this.turnedAway.delete(key)
      this.hosts.set(key, { host: claim.host, state: "signed-in" })
    }
    return found
  }

  private tokenOf(name: ForgeName, host: string): Promise<Token | Problem> {
    const key = hostKey(name, host)
    const held = this.held.get(key)
    if (held && (held.expiresAt === undefined || held.expiresAt - marginMs > this.now()))
      return Promise.resolve(held)
    this.held.delete(key)
    const asking = this.asking.get(key)
    if (asking) return asking
    const ask = this.forges[name]
      .token(this.run, host)
      .catch((error: unknown): Problem => ({
        kind: "unknown",
        said: error instanceof Error ? error.message : String(error),
      }))
      .then((got) => {
        if (isProblem(got)) this.noteHost(name, host, got)
        else if (this.options.enabled().includes(name)) {
          this.held.set(key, got)
          // The token the host last turned away, handed out again, is no sign-in: a look that
          // backed off for it keeps backing off.
          if (this.turnedAway.get(key) !== got.value) this.noteHost(name, host, "ok")
        }
        return got
      })
      .finally(() => this.asking.delete(key))
    this.asking.set(key, ask)
    return ask
  }

  // Records where a host stands; an answer that says nothing of the person's sign-in (offline,
  // limited) leaves what was known.
  private noteHost(name: ForgeName, host: string, got: "ok" | Problem): void {
    // A forge switched off meanwhile keeps nothing.
    if (!this.options.enabled().includes(name)) return
    const key = hostKey(name, host)
    if (got === "ok") {
      // Only a token other than the one the host turned away gets here (`tokenOf`), so a
      // refused host is mended as a signed-out one is.
      const before = this.hosts.get(key)?.state
      this.hosts.set(key, { host, state: "signed-in" })
      // Signed in since it was not: what backed off for it is looked at again.
      if (before === "signed-out" || before === "refused") {
        for (const look of this.looks.values())
          if (look.forge === name) look.nextAt = look.blockedUntil = look.failures = 0
        void this.tick()
      }
    } else if (got.kind === "signed-out") {
      this.hosts.set(key, { host, state: "signed-out", fix: got.fix })
    } else if (got.kind === "refused") {
      this.hosts.set(key, {
        host,
        state: "refused",
        ...(got.fix && { fix: got.fix }),
      })
    } else if (got.kind === "unknown") {
      log.debug("forges.token-failed", "Novadeck could not get a token", {
        data: { forge: name, host, said: got.said.slice(0, 500) },
      })
    }
  }

  private remoteOf(commonDir: string): Promise<Remote | undefined> {
    const known = this.remotes.get(commonDir)
    // An origin added or moved since, or a read that failed, is read again in a while.
    if (known && this.now() - known.at < this.every) return known.found
    const found = (this.options.remote ?? originOf)(commonDir).then(
      (url) => (url === undefined ? undefined : parseRemote(url)),
      // A reader that throws is no origin, this time: it never stops the pass.
      (error: unknown) => {
        log.debug("forges.remote-failed", "Novadeck could not read a repository's origin", {
          err: error,
        })
        return undefined
      },
    )
    this.remotes.set(commonDir, { at: this.now(), found })
    return found
  }

  private signedHosts(name: ForgeName): Promise<readonly string[]> {
    const known = this.signed.get(name)
    if (known && this.now() - known.at < this.every) return known.hosts
    const hosts = this.forges[name].signedIn(this.run).then(
      (got) => {
        if (!isProblem(got)) return got
        if (got.kind === "unknown")
          log.debug("forges.signed-in-failed", "Novadeck could not list a tool's hosts", {
            data: { forge: name, said: got.said.slice(0, 500) },
          })
        return []
      },
      () => [],
    )
    this.signed.set(name, { at: this.now(), hosts })
    return hosts
  }

  // The repository a remote names, by the first forge that claims it: by name or shape
  // first, then by the hosts the tools are signed in to.
  private async claim(
    commonDir: string,
    among: readonly ForgeName[],
  ): Promise<Repository | undefined> {
    const remote = await this.remoteOf(commonDir)
    if (!remote) return undefined
    for (const name of among) {
      const found = this.forges[name].repository(remote)
      if (found) return found
    }
    const signed = await Promise.all(among.map((name) => this.signedHosts(name)))
    for (const [index, name] of among.entries()) {
      const found = this.forges[name].repository(remote, signed[index])
      if (found) return found
    }
    return undefined
  }

  private async claims(among: readonly ForgeName[]): Promise<Repository[]> {
    const found = await Promise.all(
      this.options.repositories().map(({ commonDir }) => this.claim(commonDir, among)),
    )
    return found.filter((each): each is Repository => each !== undefined)
  }
}

const hostKey = (name: ForgeName, host: string): string => `${name}\0${host}`

// The repository's origin, its `insteadOf` rewrites applied (`gh:owner/repo` is the URL they
// make of it); undefined where there is none.
const originOf = async (commonDir: string): Promise<string | undefined> => {
  const found = await git(homeOf(commonDir), ["remote", "get-url", "origin"], {
    cap: 4096,
  })
  const url = found.ok ? found.out.trim() : ""
  return url === "" ? undefined : url
}
