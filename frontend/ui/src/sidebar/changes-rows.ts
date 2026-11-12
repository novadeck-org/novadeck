import { unread, type Work, type WorkFile } from "@novadeck/core/works"

// The Changes panel's rows, from the project's works (one per tracked worktree, keyed by its
// root): which come first, what each row says and which files it lists. The component only
// draws them.

// How many rows the selected work unfolds under its line before the last counts the rest.
export const branchRows = 6

// One file as a row shows it: its base name, whether it holds lines the person hasn't read, and
// whether the conflict is in it.
export type FileView = {
  readonly path: string
  readonly name: string
  readonly unread: boolean
  readonly conflict: boolean
  readonly added: number
  readonly removed: number
}

// A row under the selected work: a file, or the count of those past the last row.
export type BranchView =
  | { readonly kind: "file"; readonly file: FileView }
  | { readonly kind: "more"; readonly text: string }

// What a row's × does: asks the runner to close the worktree, which answers at once or says what
// it holds for the person to confirm; or is not available because the owner's agent is
// mid-turn in it. Whether to ask is the runner's to say, not the row's files.
export type CloseMode = "close" | "busy"

export type ChangeRow = {
  readonly work: Work
  // The owner terminal's title, or "No owner".
  readonly title: string
  // The branch, or "detached".
  readonly branch: string
  readonly close: CloseMode
  readonly unread: boolean
  // The work has just joined the unread rows.
  readonly arrived: boolean
  // The first of the read rows below unread ones: the line goes above it.
  readonly readStart: boolean
  readonly conflict: boolean
  // What the conflict is with, in words ("Conflicts with main"), or none.
  readonly conflictWords: string | undefined
  // How old the main branch it is measured against is ("main as of 12 min ago"), or none where
  // its repository's origin was never fetched.
  readonly mainWords: string | undefined
  readonly files: readonly FileView[]
  readonly branches: readonly BranchView[]
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

const view = (file: WorkFile): FileView => ({
  path: file.path,
  name: baseName(file.path),
  unread: file.unreadAdded + file.unreadRemoved > 0,
  conflict: file.conflict,
  // What the row's right end says: the unread lines.
  added: file.unreadAdded,
  removed: file.unreadRemoved,
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

// Whether the owner is a terminal of the project still open, which has a bar to show a work on.
export const ownerOpen = (
  terminalId: string | null,
  titles: ReadonlyMap<string, string>,
): boolean => terminalId !== null && titles.has(terminalId)

// Whose a work is, as a row names it: its owner's title, "Closed terminal" for an owner no
// longer among the project's terminals (it is in History), "No owner" without one.
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
): string | undefined => {
  if (work.conflicts.length === 0) return undefined
  const names = [
    ...new Set(
      work.conflicts.map((conflict) => {
        if (conflict.with === "main") return "main"
        if (conflict.terminalId !== null && titles.has(conflict.terminalId))
          return titles.get(conflict.terminalId)!
        return works.find((other) => other.root === conflict.root)?.branch ?? "another worktree"
      }),
    ),
  ]
  return `Conflicts with ${names.join(", ")}`
}

// How old main is, in words, from when the repository's origin was last fetched; none when it
// never was. Rounded down to the minute, hour or day, so it does not change by the second.
export const mainWords = (fetchedAt: number | undefined, now: number): string | undefined => {
  if (fetchedAt === undefined) return undefined
  const minutes = Math.max(0, Math.floor((now - fetchedAt) / 60_000))
  if (minutes < 1) return "main as of just now"
  if (minutes < 60) return `main as of ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `main as of ${hours} h ago`
  return `main as of ${Math.floor(hours / 24)} d ago`
}

// What its × does: waits while the owner's agent is working in the worktree.
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

// Each work's (by root) unread state as the next `arrivals` compares with, or null while the works
// aren't synced: what is listed then (the panel just opened, the backend just started) is a
// baseline, not news.
export const unreadStates = (
  works: readonly Work[],
  synced: boolean,
): ReadonlyMap<string, boolean> | null =>
  synced ? new Map(works.map((work) => [work.root, unread(work)])) : null

// Which works (by root) have just joined the unread ones since `before` (each work's unread state
// at the last look; null before the first synced one): a work new to the list, or one that
// was read.
export const arrivals = (
  before: ReadonlyMap<string, boolean> | null,
  works: readonly Work[],
): readonly string[] =>
  before === null
    ? []
    : works
        .filter((work) => unread(work) && before.get(work.root) !== true)
        .map((work) => work.root)

// The works in the order of the list: unread above read, each first come, first served.
export const orderedWorks = (works: readonly Work[]): readonly Work[] =>
  works
    .map((work, index) => ({ work, index }))
    .toSorted(
      (a, b) =>
        Number(!unread(a.work)) - Number(!unread(b.work)) ||
        a.work.firstSeenAt - b.work.firstSeenAt ||
        a.index - b.index,
    )
    .map(({ work }) => work)

export const changeRows = (
  works: readonly Work[],
  titles: ReadonlyMap<string, string>,
  arrived: readonly string[] = [],
  now = Date.now(),
): readonly ChangeRow[] =>
  orderedWorks(works).map((work, index, ordered) => {
    const files = orderedFiles(work.files)
    const isUnread = unread(work)
    const words = conflictWords(work, titles, works)
    return {
      work,
      title: ownerTitle(work.terminalId, titles),
      branch: work.branch ?? "detached",
      close: closeMode(work),
      unread: isUnread,
      arrived: arrived.includes(work.root),
      readStart: !isUnread && index > 0 && unread(ordered[index - 1]!),
      conflict: words !== undefined,
      conflictWords: words,
      mainWords: mainWords(work.fetchedAt, now),
      files,
      branches: branchViews(files, work.truncated),
    }
  })
