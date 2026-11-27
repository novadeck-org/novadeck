import type {
  CheckoutUpdate,
  ProjectFiles,
  ProjectSync,
  RepoSync,
  SyncLanding,
} from "@novadeck/core/files"
import { createStore, type Store } from "@novadeck/core/store"

// What the Files panel tells of each git repository's sync with its origin (see `RepoSync`): the
// feed that follows the backend's word, and the words the marks, the cards and the line say it in.

// How often the backend is asked again how the repositories stand while anything follows them: a
// fetch that moved main, or the person's own pull or commit (the commit it is at changes), shows
// within this.
export const syncPollMs = 20_000
// While nothing shows them (the Files panel is hidden), they are followed for the rail's dot and the
// notices only, which can wait: a fetch every five minutes is what there is to see.
export const syncSlowPollMs = 120_000

export type SyncFeed = {
  readonly store: Store<ProjectSync | undefined>
  // Follows the repositories (the first call asks at once, and then every `syncSlowPollMs`, or
  // every `syncPollMs` while any caller follows them `fast`, as the shown panel does) until the
  // returned release is called; the last one to let go stops the asking.
  readonly retain: (fast?: boolean) => () => void
  // Asks again now, once the answer under way, if any, is in.
  readonly refresh: () => void
  // The person saw what main's move up to the commit `to` brought in the repository at `path`.
  readonly seen: (path: string, to: string) => void
  // Moves the repository's checkout to main on the person's say.
  readonly update: (path: string) => Promise<CheckoutUpdate>
}

const sameSync = (a: ProjectSync | undefined, b: ProjectSync): boolean =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b)

// The feed of one project's repositories over the backend's calls; undefined where it tells none.
export const createSyncFeed = (
  files: Pick<ProjectFiles, "sync" | "seen" | "update">,
  projectId: string,
): SyncFeed | undefined => {
  const { sync } = files
  if (!sync) return undefined
  const store = createStore<ProjectSync | undefined>(undefined)
  let users = 0
  let fastUsers = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let reading = false
  let again = false
  // Said once for each time the reads begin to fail, not at every poll.
  let failing = false
  const read = async (): Promise<void> => {
    if (reading) {
      again = true
      return
    }
    reading = true
    do {
      again = false
      // eslint-disable-next-line no-await-in-loop -- One read at a time (a big repository's can take long).
      const next = await sync(projectId).catch((error: unknown) => {
        if (!failing) console.warn("Novadeck couldn't read how its repositories stand:", error)
        failing = true
        return undefined
      })
      if (next) failing = false
      if (next) store.update((known) => (sameSync(known, next) ? known! : next))
      // eslint-disable-next-line no-unmodified-loop-condition -- Others retain and release meanwhile.
    } while (again && users > 0)
    reading = false
  }
  // The asking, at the pace of whoever follows closest; `now` asks at once as well.
  const schedule = (now: boolean): void => {
    clearInterval(timer)
    timer = undefined
    if (users === 0) return
    if (now) void read()
    timer = setInterval(() => void read(), fastUsers > 0 ? syncPollMs : syncSlowPollMs)
  }
  return {
    store,
    retain: (fast = false) => {
      users += 1
      if (fast) fastUsers += 1
      schedule(users === 1 || (fast && fastUsers === 1))
      let released = false
      return () => {
        if (released) return
        released = true
        users -= 1
        if (fast) fastUsers -= 1
        schedule(false)
      }
    },
    refresh: () => void read(),
    seen: (path, to) => {
      // At once, so the mark goes with the click; the backend's word follows.
      store.update((known) =>
        known?.repos.some((repo) => repo.path === path && repo.landing?.to === to)
          ? {
              repos: known.repos.map((repo) =>
                repo.path === path ? { ...repo, landing: null } : repo,
              ),
            }
          : known,
      )
      void (files.seen?.(projectId, path, to) ?? Promise.resolve())
        .catch(() => undefined)
        .finally(() => void read())
    },
    update: async (path) => {
      const done: CheckoutUpdate = await (
        files.update?.(projectId, path) ??
        Promise.resolve<CheckoutUpdate>({ ok: false, said: "There is nothing to update." })
      ).catch(() => ({ ok: false as const, said: "Novadeck couldn't update it." }))
      void read()
      return done
    },
  }
}

// One feed for each backend's files and project, so the panel, the rail's dot and the notices all
// follow the same repositories and agree on what was seen.
const feeds = new WeakMap<object, Map<string, SyncFeed | undefined>>()

export const syncFeedOf = (
  files: ProjectFiles | undefined,
  projectId: string,
): SyncFeed | undefined => {
  if (!files) return undefined
  const byProject = feeds.get(files) ?? new Map<string, SyncFeed | undefined>()
  feeds.set(files, byProject)
  if (!byProject.has(projectId)) byProject.set(projectId, createSyncFeed(files, projectId))
  return byProject.get(projectId)
}

// News is what the person has yet to look at: a landing they haven't opened, or main left behind.
export const hasNews = (repo: RepoSync): boolean => repo.landing !== null || repo.behind !== null

// Whether a closed folder hides a repository with news.
export const hidesNews = (folder: string, repos: readonly RepoSync[]): boolean =>
  repos.some((repo) => repo.path.startsWith(`${folder}/`) && hasNews(repo))

// What a landing counts: its merges, or its commits where git named none.
export const newCount = (landing: SyncLanding): number => landing.merges.length || landing.commits

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

// "merge" while any commit of the landing was a pull request, "commit" for plain ones alone.
const kindOf = (merges: readonly { readonly pr: number | null }[]): string =>
  merges.some(({ pr }) => pr !== null) ? "merge" : "commit"

type MarkWords = {
  // What is drawn: "3 new", "↓1", "↑2".
  readonly text: string
  // The mark in words, for its tooltip and its row's name.
  readonly tip: string
}
export type SyncMark =
  | (MarkWords & { readonly kind: "new" | "behind" })
  | (MarkWords & { readonly kind: "ahead" })

const lowered = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

// Why main was left behind, as a clause.
export const whyBehind = (behind: NonNullable<RepoSync["behind"]>): string =>
  behind.why === null ? "Novadeck hasn't moved it yet" : lowered(behind.why).replace(/\.$/, "")

// The marks a repository wears, in the order they sit: what landed, what is behind, what is ahead.
export const marksOf = (repo: RepoSync): readonly SyncMark[] => [
  ...(repo.landing
    ? [
        {
          kind: "new" as const,
          text: `${newCount(repo.landing)} new`,
          tip: `${plural(newCount(repo.landing), kindOf(repo.landing.merges))} from origin`,
        },
      ]
    : []),
  ...(repo.behind
    ? [
        {
          kind: "behind" as const,
          text: `↓${repo.behind.count}`,
          tip: `${repo.behind.count} behind origin: ${whyBehind(repo.behind)}`,
        },
      ]
    : []),
  ...(repo.ahead > 0
    ? [
        {
          kind: "ahead" as const,
          text: `↑${repo.ahead}`,
          tip: `${plural(repo.ahead, "commit")} not on origin yet`,
        },
      ]
    : []),
]

// When something landed, in a few words.
export const agoOf = (at: number, now: number): string => {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}

// The card's foot for a landing: how many merges, when, and what the tree shows of them.
export const landingFoot = (landing: SyncLanding, now: number): string =>
  [
    plural(newCount(landing), kindOf(landing.merges)),
    agoOf(landing.at, now),
    landing.ref === true
      ? "main moved, your files didn't"
      : landing.filesTotal === 0
        ? "no files changed"
        : "changed files pulse in the tree",
  ].join(" · ")

// The command that moves a behind repository's main, as the runner does it: the runner says it.
// A runner before that (revision 24) doesn't, and none is guessed: its move depends on the branch.
export const moveCommand = (behind: NonNullable<RepoSync["behind"]>): string | undefined =>
  behind.command

// The first characters of a commit, as git shortens it.
export const shortSha = (commit: string): string => commit.slice(0, 7)

// Where a merge's pull request is on its forge's web, or undefined where there is none to open.
export const pullHref = (repo: RepoSync, pr: number | null): string | undefined => {
  if (pr === null || !repo.pullUrl) return undefined
  const url = repo.pullUrl.replace("{number}", String(pr))
  return /^https?:\/\//i.test(url) ? url : undefined
}

// How long a command ran, in a few words.
export const elapsedOf = (ms: number): string => {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} min${seconds % 60 === 0 ? "" : ` ${seconds % 60} s`}`
}

// How a terminal the card opened for a command stands: still going, or over, and for how long.
export type TerminalProgress = {
  // `finished` says nothing of whether it worked: nothing tells a program's exit status in a shell.
  readonly phase: "running" | "finished" | "failed"
  // How long it ran, where that was seen.
  readonly ms?: number | undefined
}

// What the card does with terminals, given by the app that has them: opens one in a folder with a
// command that it types at its first prompt (it is not brought into view), brings one forward, and
// follows one, from when it began.
export type SyncTerminals = {
  readonly run: (input: {
    readonly directory: string | undefined
    readonly command: string
  }) => string
  readonly show: (id: string) => void
  readonly follow: (id: string, since: number) => TerminalFollower
}

// A terminal's progress as a store a component reads: it tells while something subscribes.
export type TerminalFollower = {
  readonly subscribe: (listener: () => void) => () => void
  readonly get: () => TerminalProgress
}

// The terminal a landing's dependency command was run in, and when.
export type DependencyRun = {
  readonly key: string
  readonly id: string
  readonly startedAt: number
}

// What Run did to a repository's main, here: it is under way, moved it, or git said no, in its own
// words (`git`) or, where it wasn't git, in Novadeck's (`said`).
export type UpdateRun =
  | { readonly state: "running" }
  | { readonly state: "ok" }
  | {
      readonly state: "refused"
      readonly said: string
      readonly git?: readonly string[] | undefined
      readonly more?: number | undefined
    }

// What Run did, with the command it was for and how the repository stood when it ran: a refusal
// is of that standing alone, and what it says is only of that command.
export type RepoRun = {
  readonly command: string
  readonly standing: string
  readonly run: UpdateRun
}

// How a repository's main stands behind, as one value: a refusal or a move is of it and no other.
export const behindStanding = (repo: RepoSync): string =>
  repo.behind
    ? `${repo.behind.count}|${repo.behind.local ?? ""}|${repo.behind.why ?? ""}|${repo.behind.command ?? ""}`
    : ""

// The lockfile's path as the card says it: from the repository, not the project.
export const lockPathIn = (repo: RepoSync, file: string): string =>
  repo.path !== "" && file.startsWith(`${repo.path}/`) ? file.slice(repo.path.length + 1) : file

// The last part of a path.
export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

// Whether the repository the project's own folder is in has news: the line above the tree.
export const rootRepo = (repos: readonly RepoSync[]): RepoSync | undefined =>
  repos.find((repo) => repo.path === "")

// What the id of a notice about a landing starts with, so a click on it shows the Files panel.
export const landingNoticePrefix = "main-"

// The notice a landing earns, or undefined: only a pull request of one of the person's agents that
// landed in main, or new dependencies. A teammate's merge alone waits on the repository's row.
export const landingNotice = (
  repo: RepoSync,
  landing: SyncLanding,
): { readonly id: string; readonly title: string; readonly body: string } | undefined => {
  const id = `${landingNoticePrefix}${landing.to.slice(0, 12)}`
  // Only what came in the last move: the earlier ones the person was told of.
  const own = landing.merges.filter((merge) => merge.own && merge.latest)
  const hint =
    landing.dependencies && landing.dependenciesLatest
      ? `New dependencies: run ${landing.dependencies.command} before you start the app.`
      : undefined
  const first = own[0]
  if (first)
    return {
      id,
      title: `${first.subject}${own.length > 1 ? ` and ${own.length - 1} more` : ""} landed in ${repo.branch}`,
      body: hint ?? `${repo.name} caught up with origin`,
    }
  if (landing.dependencies && landing.dependenciesLatest)
    return {
      id,
      title: `New dependencies in ${repo.name}`,
      body: `${baseName(landing.dependencies.file)} changed. Run ${landing.dependencies.command} before you start the app.`,
    }
  return undefined
}

// The landings in `repos` not told of yet, as the person is told of them: each is remembered in
// `told` the first time it is seen, so none comes twice, and one that landed before `began` (the app
// found it there) or that earns no notice is none. `notify` false (the person is looking, or
// doesn't want them) remembers them all and returns none.
export const freshNotices = (
  repos: readonly RepoSync[],
  told: Set<string>,
  began: number,
  notify: boolean,
): readonly { readonly id: string; readonly title: string; readonly body: string }[] =>
  repos.flatMap((repo) => {
    const { landing } = repo
    if (!landing || told.has(landing.to)) return []
    told.add(landing.to)
    if (!notify || landing.at < began) return []
    const notice = landingNotice(repo, landing)
    return notice ? [notice] : []
  })

// How many commits each repository (by path) was behind when the person last had the Files panel
// open: what the rail's dot has been told of.
export type Acknowledged = ReadonlyMap<string, number>

// What the rail's dot says, or undefined for none: a landing not yet seen, or main left behind that
// the person hasn't had the panel open on, since it began or grew. A repository behind only while
// Novadeck hasn't moved it yet (no reason) is no news: it is moved a moment later.
export const filesNews = (
  repos: readonly RepoSync[],
  acknowledged: Acknowledged,
): string | undefined => {
  const landed = repos.filter((repo) => repo.landing !== null).length
  const behind = repos.filter(
    (repo) =>
      repo.behind !== null &&
      repo.behind.why !== null &&
      repo.behind.count > (acknowledged.get(repo.path) ?? 0),
  ).length
  if (landed === 0 && behind === 0) return undefined
  return [
    landed > 0 ? (landed === 1 ? "main moved" : `main moved in ${landed} repositories`) : "",
    behind > 0 ? (behind === 1 ? "one is behind origin" : `${behind} are behind origin`) : "",
  ]
    .filter(Boolean)
    .join(", ")
}

// The repositories behind as they stand: what having the panel open acknowledges. One that is no
// longer behind is forgotten, so it lights the dot again when it falls behind anew.
export const acknowledgedOf = (repos: readonly RepoSync[]): Acknowledged =>
  new Map(repos.flatMap((repo) => (repo.behind ? [[repo.path, repo.behind.count] as const] : [])))
