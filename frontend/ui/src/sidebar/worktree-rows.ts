import type { LitTeams, Team } from "@novadeck/core/derivations"
import { fetchAge, staleFetchMs } from "@novadeck/core/fetch-age"
import type { PullRequest, PullRequestCheck, PullRequestReview } from "@novadeck/core/forges"
import type { Work } from "@novadeck/core/works"
import type { GlyphPhase, GlyphWait } from "@novadeck/toolkit/PhaseGlyph"

// The Worktrees panel's rows, from the open project's works (one per tracked worktree, keyed by
// its root): their order and what each row says. A row is drawn as a terminal's tab: its title
// and pull request on the first line, then what the worktree does in the tab's glyphs, where its
// work goes ("main ‹ branch"), what it needs of the person (! or ?) and whose it is. The
// component only draws them.

// What a worktree is doing, in the tab's glyph vocabulary (PhaseGlyph): files changing now (its
// owner's agent is mid-turn in it), waiting on its pull request's checks, nothing in it yet, at
// rest, untouched a day or more, landed in its target, its checks failed, its pull request
// closed, or what it holds couldn't be read.
export type WorktreeState =
  | "changing"
  | "checks"
  | "empty"
  | "rest"
  | "dormant"
  | "landed"
  | "failed"
  | "over"
  | "unknown"

// How long a worktree goes untouched before it reads as dormant: a day.
export const dormantMs = 24 * 60 * 60_000

// Each state as a phase glyph draws it, and in words for a screen reader (none at rest).
export const stateGlyphs: Readonly<
  Record<
    WorktreeState,
    {
      readonly phase: GlyphPhase
      readonly failed?: true
      readonly wait?: GlyphWait
    }
  >
> = {
  changing: { phase: "running" },
  // Checks under way: the wait mark a quarter filled, as a tab's wake-up coming near.
  checks: { phase: "waiting", wait: { kind: "wake", fill: 1 } },
  empty: { phase: "starting" },
  rest: { phase: "idle" },
  dormant: { phase: "sleeping" },
  landed: { phase: "done" },
  failed: { phase: "done", failed: true },
  over: { phase: "ended" },
  unknown: { phase: "unheard" },
}

const stateWords = (state: WorktreeState, landed: string): string | undefined =>
  ({
    changing: "files changing",
    checks: "checks running",
    empty: "nothing in it yet",
    rest: undefined,
    dormant: "untouched for a day or more",
    landed: `landed in ${landed}`,
    failed: "checks failed",
    over: "pull request closed",
    unknown: "what it holds can't be read",
  })[state]

// What a worktree needs of the person, as a tab's need mark says it: `!` where its work can't go
// on without them (a conflict, files left behind after it landed, work only here with no agent
// on it), `?` where it waits on their call (its pull request's checks passed). `why` says it in
// words, the mark's tooltip.
export type RowNeed = { readonly need: "unblock" | "ask"; readonly why: string }

// What its trash button does: asks the runner to close the worktree, which answers at once or
// says what it holds for the person to confirm; or waits, as its owner's agent is mid-turn in it.
// Whether to ask is the runner's to say, not the row's.
export type CloseMode = "close" | "busy"

// A work's pull request as its row shows it: "#812" tinted by its state, the words a screen
// reader gets ("#812, draft pull request") and the page it opens; none for an address that is
// not a web page.
export type PullMark = {
  readonly state: PullRequest["state"]
  readonly text: string
  readonly label: string
  readonly url: string | undefined
}

export const pullMark = ({ number, state, url }: PullRequest): PullMark => {
  const web = /^https?:\/\//i.test(url)
  return {
    state,
    text: `#${number}`,
    label: `#${number}, ${state} pull request`,
    url: web ? url : undefined,
  }
}

// An open pull request's checks and review as the bar under its number draws them: a segment per
// check (passed, failed, running, then waiting), or, past `barChecks`, one per state as wide as
// its share; then its review, a step apart. `words` says it all, the bar's tooltip.
export type ChecksBar = {
  readonly segments: readonly {
    readonly key: string
    readonly state: PullRequestCheck["state"]
    readonly weight: number
  }[]
  readonly review: PullRequestReview | undefined
  readonly words: string
}

// How many checks the bar draws one by one; more stand as one segment per state.
export const barChecks = 12

const checkOrder: readonly PullRequestCheck["state"][] = ["passed", "failed", "running", "waiting"]

const reviewWords: Readonly<Record<PullRequestReview, string>> = {
  approved: "approved",
  changes_requested: "changes requested",
  required: "approval missing",
  none: "no review asked for",
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

export const checksBar = (pull: PullRequest): ChecksBar | undefined => {
  if (pull.state !== "open" && pull.state !== "draft") return undefined
  const checks = pull.checks ?? []
  if (checks.length === 0 && pull.review === undefined) return undefined
  const counts = new Map(
    checkOrder.map((state) => [state, checks.filter((check) => check.state === state).length]),
  )
  const segments =
    checks.length > barChecks
      ? checkOrder.flatMap((state) =>
          counts.get(state)! > 0 ? [{ key: state, state, weight: counts.get(state)! }] : [],
        )
      : checkOrder.flatMap((state) =>
          checks
            .filter((check) => check.state === state)
            .map((check, at) => ({ key: `${check.name}#${at}`, state, weight: 1 })),
        )
  const said = [
    checks.length > 0 &&
      `${counts.get("passed")} of ${plural(checks.length, "check", "checks")} passed`,
    counts.get("failed")! > 0 && `${counts.get("failed")} failed`,
    counts.get("running")! > 0 && `${counts.get("running")} running`,
    counts.get("waiting")! > 0 && `${counts.get("waiting")} waiting`,
  ].filter(Boolean)
  const review = pull.review && reviewWords[pull.review]
  return {
    segments,
    review: pull.review,
    words: [said.join(", "), review].filter(Boolean).join("; "),
  }
}

export type WorktreeRow = {
  readonly work: Work
  // Its title, as its agent gave it; its branch where it has none (made by hand, or before
  // titles), which the row sets in mono.
  readonly name: string
  readonly untitled: boolean
  // The owner terminal's title, "Closed terminal" or "No owner", for what names the row in words.
  readonly owner: string
  // The owner terminal's handle, bare ("moth"), where it has one.
  readonly handle: string | undefined
  readonly state: WorktreeState
  readonly need: RowNeed | undefined
  // Where its work goes: its pull request's target, else its home, else the main branch.
  readonly target: string
  // The branch, or "detached".
  readonly branch: string
  // Lines changed the person hasn't read yet: its branch brightens, as a tab's program does.
  readonly unread: boolean
  readonly pullRequest: PullMark | undefined
  readonly bar: ChecksBar | undefined
  // Closing it leaves nothing that lives only here (the runner's word): its trash is full
  // strength, and Trash N safe takes it.
  readonly safe: boolean
  readonly close: CloseMode
  // The worktrees it heads to, the nearest first: its lead's, its lead's lead's (teams below).
  readonly above: readonly string[]
  // What a screen reader hears for the row.
  readonly label: string
}

// Whether the owner is a terminal still open, which has a bar to show a work on.
export const ownerOpen = (
  terminalId: string | null,
  titles: ReadonlyMap<string, string>,
): boolean => terminalId !== null && titles.has(terminalId)

// Whose a work is, in words: its owner's title, "Closed terminal" for an owner no longer among
// the terminals (it is in History), "No owner" without one.
export const ownerTitle = (
  terminalId: string | null,
  titles: ReadonlyMap<string, string>,
): string => (terminalId === null ? "No owner" : (titles.get(terminalId) ?? "Closed terminal"))

// What a work conflicts with, in words: main (or the target it is measured against), and the
// other works by their owners' titles (or, with none, their branches).
export const conflictWords = (
  work: Work,
  titles: ReadonlyMap<string, string>,
  works: readonly Work[] = [],
  main = "main",
): string | undefined => {
  if (work.conflicts.length === 0) return undefined
  const names = [
    ...new Set(
      work.conflicts.map((conflict) => {
        if (conflict.with === "main") return main
        if (conflict.terminalId !== null && titles.has(conflict.terminalId))
          return titles.get(conflict.terminalId)!
        return works.find((other) => other.root === conflict.root)?.branch ?? "another worktree"
      }),
    ),
  ]
  return `Conflicts with ${names.join(", ")}`
}

// The branch a work's work goes to: its pull request's target, else the home it was opened with,
// else the main branch it's measured against, without its remote.
export const targetOf = (work: Work): string =>
  work.pullRequest?.base ?? work.home ?? work.base.replace(/^origin\//, "")

// Whether its work is in its target: git says merged, or its pull request was.
const landedOf = (work: Work): boolean => work.merged || work.pullRequest?.state === "merged"

// What a worktree is doing, most telling first: a working agent wins, then what its pull request
// or git says is over, then its checks, then whether it can be read, and how long it was left.
export const stateOf = (work: Work, now: number): WorktreeState => {
  const pull = work.pullRequest
  if (work.working) return "changing"
  if (!landedOf(work) && pull?.state === "closed") return "over"
  if (landedOf(work)) return "landed"
  if (pull?.ci === "failing") return "failed"
  if (pull?.ci === "running") return "checks"
  if (work.uncommitted === undefined) return "unknown"
  if (work.changedAt !== undefined && now - work.changedAt >= dormantMs) return "dormant"
  if (work.files.length === 0 && !pull && (work.unpushed ?? 0) === 0) return "empty"
  return "rest"
}

// The branch git measures a work's conflicts and landing against: its home, else main, without
// its remote. A pull request's target may differ (a stacked one without a recorded home).
const measuredOf = (work: Work): string => work.base.replace(/^origin\//, "")

// Where its work landed, in words: the pull request's target once the forge merged it, else the
// branch git found it in.
const landedIn = (work: Work): string =>
  work.pullRequest?.state === "merged" ? targetOf(work) : measuredOf(work)

// What a worktree needs of the person, `!` before `?`.
export const needOf = (
  work: Work,
  titles: ReadonlyMap<string, string>,
  works: readonly Work[],
): RowNeed | undefined => {
  const pull = work.pullRequest
  const landed = landedOf(work)
  const over = !landed && pull?.state === "closed"
  const uncommitted = work.uncommitted ?? 0
  const unpushed = work.unpushed ?? 0
  if (!landed && !over) {
    const conflict = conflictWords(work, titles, works, measuredOf(work))
    if (conflict) return { need: "unblock", why: conflict }
  }
  if ((landed || over) && work.safe === false && uncommitted + unpushed > 0) {
    const left = [
      uncommitted > 0 && `${plural(uncommitted, "file", "files")} not committed`,
      unpushed > 0 && `${plural(unpushed, "commit", "commits")} not pushed`,
    ]
      .filter(Boolean)
      .join(", ")
    return {
      need: "unblock",
      why: `${landed ? `Landed in ${landedIn(work)}` : "Pull request closed"}; ${left} here`,
    }
  }
  if (!landed && !over && !ownerOpen(work.terminalId, titles) && uncommitted + unpushed > 0) {
    const only = [
      uncommitted > 0 && plural(uncommitted, "file", "files"),
      unpushed > 0 && plural(unpushed, "commit", "commits"),
    ]
      .filter(Boolean)
      .join(" and ")
    // An owner in History keeps its handle on the row: its terminal is closed, not gone.
    return {
      need: "unblock",
      why: `${only} only here, and ${work.terminalId === null ? "no agent on it" : "its agent's terminal is closed"}`,
    }
  }
  if (pull?.state === "open" && pull.ci === "passed")
    return { need: "ask", why: "Checks passed: yours to merge" }
  return undefined
}

// How long ago the remote's main was fetched, in words for the panel's top line ("origin/main,
// 12 min ago"), and whether that is old enough to say so (an hour): from the works measured
// against a remote's main, the oldest fetch. None where no work is, or none was fetched.
export const originOf = (
  works: readonly Work[],
  now: number,
): { readonly text: string; readonly stale: boolean } | undefined => {
  const fetched = works.filter(
    (work) => work.base.startsWith("origin/") && work.fetchedAt !== undefined,
  )
  if (fetched.length === 0) return undefined
  const oldest = fetched.reduce((a, b) => (b.fetchedAt! < a.fetchedAt! ? b : a))
  return {
    text: `${oldest.base}, ${fetchAge(oldest.fetchedAt!, now)}`,
    stale: now - oldest.fetchedAt! >= staleFetchMs,
  }
}

// What its trash button does: waits while the owner's agent is working in the worktree.
export const closeMode = (work: Work): CloseMode => (work.working ? "busy" : "close")

// Which work's row is the selected one: the one last clicked while the terminal it was shown
// on is still the selected terminal, else the first work the selected terminal owns.
export const selectedRoot = (
  works: readonly Work[],
  selectedTerminal: string | undefined,
  last: { readonly root: string; readonly on: string | undefined } | undefined,
): string | undefined => {
  if (selectedTerminal === undefined) return undefined
  if (last && last.on === selectedTerminal && works.some((work) => work.root === last.root))
    return last.root
  return works.find((work) => work.terminalId === selectedTerminal)?.root
}

// The works in the order of the list: newest first, by when each first differed from main.
// Works first seen together follow the runner's order reversed, as it lists the oldest first.
export const orderedWorks = (works: readonly Work[]): readonly Work[] =>
  works
    .map((work, index) => ({ work, index }))
    .toSorted((a, b) => b.work.firstSeenAt - a.work.firstSeenAt || b.index - a.index)
    .map(({ work }) => work)

export const worktreeRows = (
  works: readonly Work[],
  titles: ReadonlyMap<string, string>,
  now = Date.now(),
  handles: ReadonlyMap<string, string> = new Map(),
  teams: WorktreeTeams = worktreeTeams(works),
): readonly WorktreeRow[] =>
  teams.order.map((work) => {
    const branch = work.branch ?? "detached"
    const target = targetOf(work)
    const state = stateOf(work, now)
    const need = needOf(work, titles, works)
    const owner = ownerTitle(work.terminalId, titles)
    const handle = work.terminalId === null ? undefined : handles.get(work.terminalId)
    const pullRequest = work.pullRequest ? pullMark(work.pullRequest) : undefined
    const bar = work.pullRequest ? checksBar(work.pullRequest) : undefined
    const name = work.title ?? branch
    const label = [
      name,
      pullRequest && [pullRequest.label, bar?.words].filter(Boolean).join(", "),
      stateWords(state, landedIn(work)),
      `${branch} into ${target}`,
      need?.why,
      handle ? `@${handle}` : "no agent",
    ]
      .filter(Boolean)
      .join(", ")
    return {
      work,
      name,
      untitled: work.title === undefined,
      owner,
      handle,
      state,
      need,
      target,
      branch,
      unread: work.unreadAdded + work.unreadRemoved > 0,
      pullRequest,
      bar,
      safe: work.safe === true,
      close: closeMode(work),
      above: chainOf(teams, work.root),
      label,
    }
  })

// ---- Teams: worktrees heading to another open worktree's branch ----

// A worktree whose target is the branch another open worktree has is that worktree's member, as a
// teammate is its lead's in the Terminals list: it hangs under it on the team wire, and folds
// into it. A member may lead its own. `order` is the list's: newest first, each lead's members
// right under it, newest first; `leadOf` each member's lead, by root; `teams` each lead's
// members, in the list's order.
export type WorktreeTeams = {
  readonly order: readonly Work[]
  readonly leadOf: ReadonlyMap<string, string>
  readonly teams: readonly Team[]
}

export const worktreeTeams = (works: readonly Work[]): WorktreeTeams => {
  const newest = orderedWorks(works)
  const byBranch = new Map(
    works.flatMap((work) => (work.branch === null ? [] : [[work.branch, work.root] as const])),
  )
  const leadOf = new Map<string, string>()
  for (const work of works) {
    const lead = byBranch.get(targetOf(work))
    if (lead !== undefined && lead !== work.root) leadOf.set(work.root, lead)
  }
  // Worktrees heading to each other's branches go round: the newest of each ring heads nowhere.
  for (const work of newest) {
    const seen = new Set<string>()
    let at = work.root
    while (leadOf.has(at) && !seen.has(at)) {
      seen.add(at)
      at = leadOf.get(at)!
      if (at === work.root) {
        leadOf.delete(work.root)
        break
      }
    }
  }
  const members = new Map<string, Work[]>()
  for (const work of newest) {
    const lead = leadOf.get(work.root)
    if (lead !== undefined) members.set(lead, [...(members.get(lead) ?? []), work])
  }
  const order: Work[] = []
  const teams: Team[] = []
  const place = (work: Work): void => {
    order.push(work)
    const own = members.get(work.root)
    if (!own) return
    teams.push({ lead: work.root, workers: own.map((each) => each.root) })
    own.forEach(place)
  }
  newest.filter((work) => !leadOf.has(work.root)).forEach(place)
  return { order, leadOf, teams }
}

// The leads above a worktree, the nearest first.
export const chainOf = (teams: WorktreeTeams, root: string): readonly string[] => {
  const chain: string[] = []
  for (let at = teams.leadOf.get(root); at !== undefined; at = teams.leadOf.get(at)) chain.push(at)
  return chain
}

// Every worktree under a lead, at any depth, in the list's order.
export const descendantsOf = (teams: WorktreeTeams, root: string): readonly string[] =>
  teams.order
    .map((work) => work.root)
    .filter((each) => each !== root && chainOf(teams, each).includes(root))

// What lights for the selected worktree, as for a selected terminal (core's litTeams): the team it
// leads, the team it is in, and the way up through the leads above.
export const litOf = (teams: WorktreeTeams, selected: string | undefined): LitTeams => {
  if (selected === undefined) return { full: [], path: [] }
  const full = teams.teams.filter(
    (team) => team.lead === selected || team.lead === teams.leadOf.get(selected),
  )
  const chain = chainOf(teams, selected)
  return { full, path: chain.slice(1).map((lead, index) => ({ lead, child: chain[index]! })) }
}

// What a worktree is in the tree of teams the selected worktree is in (core's treeRole): a lead
// or a worker, or nothing outside it, or while the selected one is in no team.
export const roleOf = (
  teams: WorktreeTeams,
  root: string,
  selected: string | undefined,
): "lead" | "worker" | undefined => {
  if (selected === undefined) return undefined
  const leads = (each: string) => teams.teams.some((team) => team.lead === each)
  if (!leads(selected) && !teams.leadOf.has(selected)) return undefined
  const top = chainOf(teams, selected).at(-1) ?? selected
  if (root !== top && !chainOf(teams, root).includes(top)) return undefined
  return leads(root) ? "lead" : "worker"
}
