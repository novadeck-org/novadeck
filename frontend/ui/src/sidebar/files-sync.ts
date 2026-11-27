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

export type SyncFeed = {
  readonly store: Store<ProjectSync | undefined>
  // Follows the repositories (the first call asks at once, and then every `syncPollMs`) until the
  // returned release is called; the last one to let go stops the asking.
  readonly retain: () => () => void
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
  let timer: ReturnType<typeof setInterval> | undefined
  let reading = false
  let again = false
  const read = async (): Promise<void> => {
    if (reading) {
      again = true
      return
    }
    reading = true
    do {
      again = false
      // eslint-disable-next-line no-await-in-loop -- One read at a time (a big repository's can take long).
      const next = await sync(projectId).catch(() => undefined)
      if (next) store.update((known) => (sameSync(known, next) ? known! : next))
      // eslint-disable-next-line no-unmodified-loop-condition -- Others retain and release meanwhile.
    } while (again && users > 0)
    reading = false
  }
  return {
    store,
    retain: () => {
      users += 1
      if (users === 1) {
        void read()
        timer = setInterval(() => void read(), syncPollMs)
      }
      let released = false
      return () => {
        if (released) return
        released = true
        users -= 1
        if (users === 0) {
          clearInterval(timer)
          timer = undefined
        }
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

// The card's sub line for a landing: how far main moved, when, and how many files changed.
export const landingSub = (repo: RepoSync, landing: SyncLanding, now: number): string =>
  [
    `${repo.branch} moved ${plural(landing.commits, "commit")}`,
    agoOf(landing.at, now),
    plural(landing.filesTotal, "file"),
  ].join(" · ")

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
  const own = landing.merges.filter((merge) => merge.own)
  const hint = landing.dependencies
    ? `New dependencies: run ${landing.dependencies.command} before you start the app.`
    : undefined
  const first = own[0]
  if (first)
    return {
      id,
      title: `${first.subject}${own.length > 1 ? ` and ${own.length - 1} more` : ""} landed in ${repo.branch}`,
      body: hint ?? `${repo.name} caught up with origin`,
    }
  if (landing.dependencies)
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
