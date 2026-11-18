import { fetchAge, staleFetchMs } from "@novadeck/core/fetch-age"
import type { PullRequest } from "@novadeck/core/forges"
import type { Work, WorkFile } from "@novadeck/core/works"

// The Worktrees panel's rows, from the open project's works (one per tracked worktree, keyed by
// its root): which come first, what each row says and which files it lists. The component only
// draws them.

// How many rows the selected work unfolds under its line before the last counts the rest.
export const branchRows = 6

// One file as a row shows it: its base name, its lines and whether the conflict is in it.
export type FileView = {
  readonly path: string
  readonly name: string
  readonly conflict: boolean
  readonly status: WorkFile["status"]
  readonly added: number
  readonly removed: number
}

// A row under the selected work: a file, or the count of those past the last row.
export type BranchView =
  | { readonly kind: "file"; readonly file: FileView }
  | { readonly kind: "more"; readonly text: string }

// What a row's trash button does: asks the runner to close the worktree, which answers at once or says what
// it holds for the person to confirm; or is not available because the owner's agent is
// mid-turn in it. Whether to ask is the runner's to say, not the row's files.
export type CloseMode = "close" | "busy"

// A work's pull request as its row's mark shows it: "#812" after a glyph of its state, the words
// a screen reader gets ("#812, draft pull request, opens in browser": its visible words first, so
// voice control finds it) and the page it opens; none for an address that is not a web page.
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
    label: `#${number}, ${state} pull request${web ? ", opens in browser" : ""}`,
    url: web ? url : undefined,
  }
}

// The group a work is listed under, by what the person would do with it next: what needs them
// (a conflict, its CI failing), what is still being made (no pull request yet), what waits on a
// review (an open pull request) and what is done (merged, or its pull request closed).
export type Group = "needs" | "progress" | "review" | "done"

export const groups: readonly { readonly key: Group; readonly title: string }[] = [
  { key: "needs", title: "Needs you" },
  { key: "progress", title: "In progress" },
  { key: "review", title: "In review" },
  { key: "done", title: "Done" },
]

// Where a work stands, as the row's icon says it: its most telling fact, in that order.
export type Standing =
  | "conflict"
  | "ci-failing"
  | "working"
  | "merged"
  | "closed"
  | "ready"
  | "draft"
  | "branch"

// One fact a row says in words, under its branch: red only for what needs the person, amber for
// what lives only here, green for what is safe to trash. `glyph` is a small mark before it.
export type Fact = {
  readonly text: string
  readonly tone: "bad" | "ink" | "muted" | "warn" | "ok"
  readonly glyph?: "ci-passed" | "ci-failing" | "ci-running" | "unpushed" | "uncommitted"
  // It says the pull request's state, so its number (a link to its page) follows it.
  readonly pull?: true
}

export type ChangeRow = {
  readonly work: Work
  // The owner terminal's title, or "No owner".
  readonly title: string
  // The owner terminal's handle as people see it ("@moth"), where it has one.
  readonly handle: string | undefined
  readonly group: Group
  readonly standing: Standing
  // What it says under its branch, most telling first.
  readonly facts: readonly Fact[]
  // Closing it leaves nothing that lives only here (the runner's word): the trash button shows
  // at rest, and Trash N safe takes it.
  readonly safe: boolean
  // The branch, or "detached".
  readonly branch: string
  readonly close: CloseMode
  // It conflicts, and was not merged.
  readonly conflict: boolean
  // What the conflict is with, in words ("Conflicts with main"), or none.
  readonly conflictWords: string | undefined
  // The work was merged ("Merged" in words); it wins over a conflict, which a merged work's
  // old branch may still have with what main changed since.
  readonly merged: boolean
  // How old the main branch it is measured against is ("main as of 12 min ago"), or none where
  // its repository's origin was never fetched.
  readonly mainWords: string | undefined
  // Its pull request on the forge, where one was found; the git-based `merged` stays as it is.
  readonly pullRequest: PullMark | undefined
  readonly files: readonly FileView[]
  readonly branches: readonly BranchView[]
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

const view = (file: WorkFile): FileView => ({
  path: file.path,
  name: baseName(file.path),
  conflict: file.conflict,
  status: file.status,
  added: file.added,
  removed: file.removed,
})

// The files, conflicting ones first, then the biggest change.
export const orderedFiles = (files: readonly WorkFile[]): readonly FileView[] =>
  files
    .map((file, index) => ({ file, index }))
    .toSorted(
      (a, b) =>
        Number(b.file.conflict) - Number(a.file.conflict) ||
        b.file.added + b.file.removed - (a.file.added + a.file.removed) ||
        a.index - b.index,
    )
    .map(({ file }) => view(file))

// The rows an unfolded work lists: every file up to `branchRows`, or past that (or where the
// work lists fewer files than it changes) one row fewer, the last counting the rest.
export const branchViews = (
  files: readonly FileView[],
  truncated: boolean,
): readonly BranchView[] => {
  const crowded = files.length > branchRows || (truncated && files.length === branchRows)
  const shown = crowded ? files.slice(0, branchRows - 1) : files
  const rows: BranchView[] = shown.map((file) => ({ kind: "file", file }))
  const rest = files.length - shown.length
  if (rest > 0) rows.push({ kind: "more", text: `+${rest} more` })
  else if (truncated) rows.push({ kind: "more", text: "and more" })
  return rows
}

// Whether the owner is a terminal still open, which has a bar to show a work on.
export const ownerOpen = (
  terminalId: string | null,
  titles: ReadonlyMap<string, string>,
): boolean => terminalId !== null && titles.has(terminalId)

// Whose a work is, as a row names it: its owner's title, "Closed terminal" for an owner no
// longer among the terminals (it is in History), "No owner" without one.
export const ownerTitle = (
  terminalId: string | null,
  titles: ReadonlyMap<string, string>,
): string => (terminalId === null ? "No owner" : (titles.get(terminalId) ?? "Closed terminal"))

// What a work conflicts with, in words: main, and the other works by their owners' titles
// (or, with none, their branches).
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

// What a work's conflict is with, as its row says it: main by the branch it is measured
// against ("origin/main"), the other works by their owners.
const conflictFact = (
  work: Work,
  titles: ReadonlyMap<string, string>,
  works: readonly Work[],
): string | undefined => conflictWords(work, titles, works, work.base)

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

// The group a work is listed under. Merged wins over a conflict (a merged work's old branch may
// still conflict with what main changed since), and a closed pull request is done too.
export const groupOf = (work: Work): Group => {
  const pull = work.pullRequest
  if (work.merged || pull?.state === "merged" || pull?.state === "closed") return "done"
  if (work.conflicts.length > 0 || pull?.ci === "failing") return "needs"
  return pull ? "review" : "progress"
}

// Where a work stands, for its row's icon.
export const standingOf = (work: Work): Standing => {
  const pull = work.pullRequest
  const done = work.merged || pull?.state === "merged"
  if (!done && pull?.state !== "closed") {
    if (work.conflicts.length > 0) return "conflict"
    if (pull?.ci === "failing") return "ci-failing"
  }
  if (work.working) return "working"
  if (done) return "merged"
  if (pull?.state === "closed") return "closed"
  if (pull?.state === "open") return "ready"
  if (pull?.state === "draft") return "draft"
  return "branch"
}

// What a row says under its branch, most telling first. `forges` is whether pull requests are
// looked for at all: while none is, the row says nothing of one, not even that there is none.
export const factsOf = (
  work: Work,
  titles: ReadonlyMap<string, string>,
  works: readonly Work[],
  forges: boolean,
): readonly Fact[] => {
  const pull = work.pullRequest
  const merged = work.merged || pull?.state === "merged"
  const closed = !merged && pull?.state === "closed"
  const open = pull?.state === "open" || pull?.state === "draft"
  const facts: Fact[] = []
  const conflict = merged || closed ? undefined : conflictFact(work, titles, works)
  if (conflict) facts.push({ text: conflict, tone: "bad" })
  if (open && pull.ci === "failing")
    facts.push({ text: "CI failing", tone: "bad", glyph: "ci-failing" })
  if (work.working) facts.push({ text: "Working", tone: "ink" })
  const numbered = pull ? ({ pull: true } as const) : {}
  if (merged) facts.push({ text: "Merged", tone: work.safe ? "ok" : "muted", ...numbered })
  else if (closed) facts.push({ text: "PR closed", tone: work.safe ? "ok" : "muted", ...numbered })
  else if (pull?.state === "open")
    facts.push({ text: "Ready for review", tone: "ink", ...numbered })
  else if (pull?.state === "draft") facts.push({ text: "Draft", tone: "muted", ...numbered })
  else if (forges) facts.push({ text: "No PR yet", tone: "muted" })
  if (open && pull.ci === "running")
    facts.push({ text: "CI running", tone: "muted", glyph: "ci-running" })
  if (open && pull.ci === "passed")
    facts.push({ text: "CI passed", tone: "muted", glyph: "ci-passed" })
  if (open && pull.ci === "none") facts.push({ text: "no CI", tone: "muted" })
  if (!merged && (work.unpushed ?? 0) > 0)
    facts.push({
      text: `${plural(work.unpushed!, "commit", "commits")} not pushed`,
      tone: "warn",
      glyph: "unpushed",
    })
  if ((merged || closed) && !work.safe && (work.uncommitted ?? 0) > 0)
    facts.push({
      text: `${plural(work.uncommitted!, "file", "files")} not committed`,
      tone: "warn",
      glyph: "uncommitted",
    })
  if (work.safe) facts.push({ text: "safe to trash", tone: "ok" })
  return facts
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
  const words = mainWords(oldest.fetchedAt, now)!.replace(/^main as of /, "")
  return {
    text: `${oldest.base}, ${words}`,
    stale: now - oldest.fetchedAt! >= staleFetchMs,
  }
}

// How old main is, in words, from when the repository's origin was last fetched; none when it
// never was. Rounded down to the minute, hour or day, so it does not change by the second.
export const mainWords = (fetchedAt: number | undefined, now: number): string | undefined =>
  fetchedAt === undefined ? undefined : `main as of ${fetchAge(fetchedAt, now)}`

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

export const changeRows = (
  works: readonly Work[],
  titles: ReadonlyMap<string, string>,
  now = Date.now(),
  handles: ReadonlyMap<string, string> = new Map(),
  forges = true,
): readonly ChangeRow[] =>
  orderedWorks(works).map((work) => {
    const files = orderedFiles(work.files)
    // Done (merged, or its pull request closed) wins over a conflict, as its group and icon say.
    const words = groupOf(work) === "done" ? undefined : conflictWords(work, titles, works)
    return {
      work,
      title: ownerTitle(work.terminalId, titles),
      handle: work.terminalId === null ? undefined : handles.get(work.terminalId),
      group: groupOf(work),
      standing: standingOf(work),
      facts: factsOf(work, titles, works, forges),
      safe: work.safe === true,
      branch: work.branch ?? "detached",
      close: closeMode(work),
      conflict: words !== undefined,
      conflictWords: words,
      merged: work.merged || work.pullRequest?.state === "merged",
      mainWords: mainWords(work.fetchedAt, now),
      pullRequest: work.pullRequest ? pullMark(work.pullRequest) : undefined,
      files,
      branches: branchViews(files, work.truncated),
    }
  })
