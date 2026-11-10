import { unread, type Work, type WorkFile } from "@novadeck/core/works"

// The Changes panel's rows, from the project's works: which come first, what each row says
// and which files it lists. The component only draws them.

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

export type ChangeRow = {
  readonly work: Work
  readonly title: string
  readonly unread: boolean
  // The work has just joined the unread rows.
  readonly arrived: boolean
  // The first of the read rows below unread ones: the line goes above it.
  readonly readStart: boolean
  readonly conflict: boolean
  // What the conflict is with, in words ("Conflicts with main"), or none.
  readonly conflictWords: string | undefined
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

// What a work conflicts with, in words: main, and the other terminals' titles.
export const conflictWords = (
  work: Work,
  titles: ReadonlyMap<string, string>,
): string | undefined => {
  if (work.conflicts.length === 0) return undefined
  const names = [
    ...new Set(
      work.conflicts.map((conflict) =>
        conflict.with === "main" ? "main" : (titles.get(conflict.terminalId) ?? "another terminal"),
      ),
    ),
  ]
  return `Conflicts with ${names.join(", ")}`
}

// Which works have just joined the unread ones since `before` (each work's unread state
// at the last look; null before the first): a work new to the list, or one that was read.
export const arrivals = (
  before: ReadonlyMap<string, boolean> | null,
  works: readonly Work[],
): readonly string[] =>
  before === null
    ? []
    : works
        .filter((work) => unread(work) && before.get(work.terminalId) !== true)
        .map((work) => work.terminalId)

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
): readonly ChangeRow[] =>
  orderedWorks(works).map((work, index, ordered) => {
    const files = orderedFiles(work.files)
    const isUnread = unread(work)
    const words = conflictWords(work, titles)
    return {
      work,
      title: titles.get(work.terminalId) ?? "Terminal",
      unread: isUnread,
      arrived: arrived.includes(work.terminalId),
      readStart: !isUnread && index > 0 && unread(ordered[index - 1]!),
      conflict: words !== undefined,
      conflictWords: words,
      files,
      branches: branchViews(files, work.truncated),
    }
  })
