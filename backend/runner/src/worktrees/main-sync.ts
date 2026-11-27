import type { CheckoutUpdate, ProjectSync, RepoSync } from "@novadeck/protocol"

import { git } from "../checkouts/git.js"
import { mainBranch } from "../checkouts/repository.js"
import { logs } from "../log.js"
import { operationIn, type Forwarded } from "./fast-forward.js"
import { landingOf, mergesOf, mergesWaiting, type Landing, type Merge } from "./landing.js"
import { commitAt } from "./repo.js"
import { KeptRepositories, type Found } from "./repositories-in.js"

const log = logs.for("worktrees")

/** A pull request from one of the person's agents' worktrees. */
export type OwnPull = { readonly number: number; readonly title: string }

/** What a recorded landing says to the runner's other parts: who is told of it. */
export type Landed = {
  readonly commonDir: string
  /** The repository's main checkout. */
  readonly home: string
  readonly name: string
  readonly landing: Landing
  /** The pull requests of the person's agents' worktrees among the landing's merges. */
  readonly own: readonly OwnPull[]
}

/** What the sync reads of the runner. */
export type MainSyncHost = {
  /** Every project the runner has, by id and folder. */
  readonly projects: () => readonly { readonly id: string; readonly cwd: string }[]
  /** How many times the runner moved the repository's checkout (`MainFetcher.moved`). */
  readonly moved: (commonDir: string) => number
  /** Moves the checkout to main on the person's say (`MainFetcher.update`). */
  readonly update: (commonDir: string) => Promise<Forwarded>
  /** The pull requests of the worktrees agents hold in the repository, as the forge knows them. */
  readonly own?: (commonDir: string) => readonly OwnPull[]
  /** Told after a landing is recorded. */
  readonly landed?: (landed: Landed) => void
  readonly now?: () => number
}

type Status = {
  readonly branch: string
  readonly remote: string
  readonly behind: number
  readonly ahead: number
  readonly why: string | null
  readonly waiting: readonly Merge[]
  readonly head: string | null
}

/** How long a repository's standing is kept before git is asked again. */
const keptMs = 5000

const small = { cap: 64 * 1024 }
const line = (run: Awaited<ReturnType<typeof git>>): string | undefined =>
  run.ok ? run.out.trim() || undefined : undefined

/** What the person's own edits say in words: the first files git lists. */
const editsIn = async (home: string): Promise<string | undefined> => {
  const status = await git(
    home,
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=no",
      "--ignore-submodules",
    ],
    { cap: 256 * 1024, ms: 60_000, truncate: true },
  )
  if (!status.ok) return undefined
  const files = status.out
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
  if (files.length === 0) return undefined
  const shown = files.slice(0, 2).join(", ")
  return files.length > 2
    ? `You have edits in ${shown} and ${files.length - 2} more`
    : `You have edits in ${shown}`
}

/**
 * Where each repository of each project stands against its origin's main: how far behind it is
 * and why the runner left it, how far ahead, and what the runner's last move of main brought that
 * the person has not seen (kept in memory, so every window agrees; a restart forgets it).
 * The runner's own moves are `MainFetcher`'s; this one reads them and the person's Update.
 */
export class MainSync {
  private readonly repositories: KeptRepositories
  private readonly landings = new Map<string, Landing>()
  private readonly tail = new Map<string, Promise<void>>()
  private readonly standing = new Map<
    string,
    { readonly at: number; readonly status: Status | undefined }
  >()
  /** The pull requests of agents' worktrees seen so far, by repository: a worktree may be cleaned up before its landing. */
  private readonly ownNumbers = new Map<string, Map<number, string>>()
  private readonly now: () => number

  constructor(private readonly host: MainSyncHost) {
    this.now = host.now ?? Date.now
    this.repositories = new KeptRepositories(this.now)
  }

  /** The git common dirs of every repository of every project: those the runner keeps current. */
  async followed(): Promise<readonly string[]> {
    const lists = await Promise.all(
      this.host.projects().map(({ cwd }) => this.repositories.of(cwd)),
    )
    return [...new Set(lists.flatMap((list) => list.map(({ commonDir }) => commonDir)))]
  }

  private remember(commonDir: string): Map<number, string> {
    const known = this.ownNumbers.get(commonDir) ?? new Map<number, string>()
    for (const { number, title } of this.host.own?.(commonDir) ?? []) known.set(number, title)
    this.ownNumbers.set(commonDir, known)
    return known
  }

  /**
   * The runner moved the repository's checkout from `from` to `to`: records what that brought,
   * joined to what the person has not yet seen of earlier moves. Moves of one repository are
   * recorded in order.
   */
  landed(commonDir: string, from: string, to: string): Promise<void> {
    const before = this.tail.get(commonDir) ?? Promise.resolve()
    const run = before.then(() => this.record(commonDir, from, to))
    const tail = run.catch(() => undefined)
    this.tail.set(commonDir, tail)
    void tail.then(() => {
      if (this.tail.get(commonDir) === tail) this.tail.delete(commonDir)
    })
    return run
  }

  /** Resolves once the landings handed to it are recorded (a test waits for them). */
  async idle(): Promise<void> {
    while (this.tail.size > 0)
      // eslint-disable-next-line no-await-in-loop -- Landings handed meanwhile are waited for too.
      await Promise.all(this.tail.values())
  }

  private async record(commonDir: string, from: string, to: string): Promise<void> {
    const found = await this.found(commonDir)
    if (found === undefined) return
    const own = this.remember(commonDir)
    const prior = this.landings.get(commonDir)
    const fresh = await landingOf(found.home, from, to, this.now())
    // What the person has yet to see is everything since the last landing they saw.
    const all =
      prior === undefined || fresh === undefined
        ? fresh
        : await landingOf(found.home, prior.from, to, fresh.at)
    this.standing.delete(commonDir)
    if (fresh === undefined || all === undefined) {
      log.debug("worktrees.landing-unread", "Novadeck could not read what main brought", {
        data: { commonDir, from, to },
      })
      return
    }
    this.landings.set(commonDir, all)
    const named = new Set(fresh.merges.flatMap(({ pr }) => (pr === null ? [] : [pr])))
    this.host.landed?.({
      commonDir,
      home: found.home,
      name: found.name,
      landing: fresh,
      own: [...own]
        .filter(([number]) => named.has(number))
        .map(([number, title]) => ({ number, title })),
    })
  }

  private async found(commonDir: string): Promise<Found | undefined> {
    for (const { cwd } of this.host.projects())
      // eslint-disable-next-line no-await-in-loop -- The first project that holds it is the one.
      for (const each of await this.repositories.of(cwd))
        if (each.commonDir === commonDir) return each
    return undefined
  }

  private async statusOf(found: Found): Promise<Status | undefined> {
    const known = this.standing.get(found.commonDir)
    if (known && this.now() - known.at < keptMs) return known.status
    const status = await this.read(found)
    this.standing.set(found.commonDir, { at: this.now(), status })
    return status
  }

  private async read({ home }: Found): Promise<Status | undefined> {
    const main = await mainBranch(home)
    if (main === undefined || !main.name.startsWith("origin/")) return undefined
    const branch = main.name.slice("origin/".length)
    const local = line(
      await git(home, ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], small),
    )
    const counts =
      local === undefined
        ? undefined
        : line(
            await git(
              home,
              ["rev-list", "--left-right", "--count", `${main.commit}...${local}`],
              small,
            ),
          )
    const [behindAll, ahead] = (counts ?? "0\t0").split(/\s+/).map((each) => Number(each) || 0)
    const onBranch =
      line(await git(home, ["symbolic-ref", "-q", "HEAD"], small)) === `refs/heads/${branch}`
    const behind = onBranch ? (behindAll ?? 0) : 0
    const head = (await commitAt(home, "HEAD")) ?? null
    let why: string | null = null
    if (behind > 0) {
      const operation = await operationIn(home)
      if (operation !== undefined) why = operation
      else if ((ahead ?? 0) > 0) why = "main has commits that origin doesn't"
      else why = (await editsIn(home)) ?? null
    }
    const waiting =
      behind > 0 && local !== undefined
        ? ((await mergesOf(home, `${local}..${main.commit}`, mergesWaiting)) ?? [])
        : []
    return { branch, remote: main.name, behind, ahead: ahead ?? 0, why, waiting, head }
  }

  /** How each repository of the project stands; those with no origin main are left out. */
  async sync(cwd: string): Promise<ProjectSync> {
    const repos: RepoSync[] = []
    for (const found of await this.repositories.of(cwd)) {
      // eslint-disable-next-line no-await-in-loop -- Git is asked of one repository at a time.
      const status = await this.statusOf(found)
      if (status === undefined) continue
      const own = this.remember(found.commonDir)
      const landing = this.landings.get(found.commonDir)
      repos.push({
        path: found.path,
        name: found.name,
        branch: status.branch,
        behind:
          status.behind > 0
            ? {
                remote: status.remote,
                count: status.behind,
                why: status.why,
                merges: status.waiting.map(({ subject, pr, commit }) => ({
                  subject: subject.slice(0, 300),
                  pr,
                  commit,
                  own: pr !== null && own.has(pr),
                })),
              }
            : null,
        ahead: status.ahead,
        landing: landing
          ? {
              from: landing.from,
              to: landing.to,
              at: landing.at,
              commits: landing.commits,
              merges: landing.merges.map(({ subject, pr, commit }) => ({
                subject: subject.slice(0, 300),
                pr,
                commit,
                own: pr !== null && own.has(pr),
              })),
              files: landing.files.map((file) =>
                found.path === "" ? file : `${found.path}/${file}`,
              ),
              filesTotal: landing.filesTotal,
              dependencies: landing.dependencies
                ? {
                    file:
                      found.path === ""
                        ? landing.dependencies.file
                        : `${found.path}/${landing.dependencies.file}`,
                    command: landing.dependencies.command,
                  }
                : null,
            }
          : null,
        moved: this.host.moved(found.commonDir),
        head: status.head,
      })
    }
    return { repos }
  }

  /** The person saw the landing of the repository at `path`; one newer than `to` stays. */
  async seen(cwd: string, path: string, to?: string): Promise<void> {
    const found = (await this.repositories.of(cwd)).find((each) => each.path === path)
    if (found === undefined) return
    const landing = this.landings.get(found.commonDir)
    if (landing && (to === undefined || landing.to === to)) this.landings.delete(found.commonDir)
  }

  /** Moves the checkout of the repository at `path` (the project's own when omitted) to main. */
  async update(cwd: string, path = ""): Promise<CheckoutUpdate> {
    const found = (await this.repositories.of(cwd)).find((each) => each.path === path)
    if (found === undefined) return { ok: false, said: "It isn't in a git repository." }
    const status = await this.statusOf(found)
    if (status && status.behind > 0 && status.ahead > 0)
      return { ok: false, said: "It has commits origin doesn't, so it can't just move forward." }
    this.standing.delete(found.commonDir)
    const done = await this.host.update(found.commonDir)
    return done.ok ? { ok: true } : done
  }
}
