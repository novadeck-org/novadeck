import { workLimits, type WorkConflict, type WorkFile } from "@novadeck/protocol"

// The pure parts of Works: reading what git printed, adding up lines, choosing which
// terminal's a shared checkout is, and putting a work together. Nothing here runs git.

/** The lines one file gained and lost. */
export type Lines = { readonly added: number; readonly removed: number }

/**
 * The files of `git diff --numstat -z --no-renames`: `added<TAB>removed<TAB>path` ended by a
 * NUL. A binary file prints `-` for both, and counts none.
 */
// A numstat count: a number of lines, or "-" for a binary file, which counts none.
const count = (text: string): number => (/^\d+$/.test(text) ? Number(text) : 0)

export const parseNumstat = (out: string): Map<string, Lines> => {
  const files = new Map<string, Lines>()
  for (const record of out.split("\0")) {
    const first = record.indexOf("\t")
    const second = record.indexOf("\t", first + 1)
    if (first < 0 || second < 0) continue
    const path = record.slice(second + 1)
    if (!path) continue
    files.set(path, {
      added: count(record.slice(0, first)),
      removed: count(record.slice(first + 1, second)),
    })
  }
  return files
}

/**
 * What `git merge-tree --write-tree --name-only --no-messages -z` printed: the tree of the
 * merge, then the names of the files that conflict, each ended by a NUL.
 */
export const parseMerge = (
  out: string,
): { readonly tree: string; readonly conflicts: string[] } => {
  const [tree = "", ...names] = out.split("\0")
  return { tree, conflicts: names.filter((name) => name !== "") }
}

/** Both sums of a set of files' lines. */
export const sum = (files: Iterable<Lines>): Lines => {
  let added = 0
  let removed = 0
  for (const file of files) {
    added += file.added
    removed += file.removed
  }
  return { added, removed }
}

/**
 * The files a work lists: the changed ones in path order, at most `workLimits.files`, each
 * with what of it is unread (all of it where `unread` is undefined, before a first look)
 * and whether it conflicts. The totals are of every file changed, whatever is cut.
 */
export const listFiles = (
  changed: ReadonlyMap<string, Lines>,
  unread: ReadonlyMap<string, Lines> | undefined,
  conflicting: ReadonlySet<string>,
): {
  readonly files: WorkFile[]
  readonly truncated: boolean
  readonly total: Lines
  readonly totalUnread: Lines
} => {
  const none: Lines = { added: 0, removed: 0 }
  const all = [...changed]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, lines]) => ({ path, lines, unread: unread ? (unread.get(path) ?? none) : lines }))
  return {
    files: all.slice(0, workLimits.files).map(({ path, lines, unread: read }) => ({
      path,
      added: lines.added,
      removed: lines.removed,
      unreadAdded: read.added,
      unreadRemoved: read.removed,
      conflict: conflicting.has(path),
    })),
    truncated: all.length > workLimits.files,
    total: sum(all.map(({ lines }) => lines)),
    totalUnread: sum(all.map(({ unread: read }) => read)),
  }
}

/** Whether two works could conflict: they changed a file in common, or one lists only part. */
export const mayConflict = (
  a: { readonly paths: ReadonlySet<string>; readonly truncated: boolean },
  b: { readonly paths: ReadonlySet<string>; readonly truncated: boolean },
): boolean => a.truncated || b.truncated || [...a.paths].some((path) => b.paths.has(path))

/** A terminal that is in a checkout, since when it has been in that one. */
export type Claim = { readonly terminalId: string; readonly root: string; readonly since: number }

/**
 * Whose a checkout's work is. One work per checkout: the terminal that has been in it the
 * longest keeps it, whoever else comes in; the earlier ids first on a tie. `owners` are the
 * ones from before: an owner still in its checkout keeps it, however long others have been
 * in it, so the row doesn't pass between terminals back and forth. Returns checkout to
 * terminal.
 */
export const attribute = (
  claims: readonly Claim[],
  owners: ReadonlyMap<string, string>,
): Map<string, string> => {
  const chosen = new Map<string, Claim>()
  for (const claim of claims) {
    const held = chosen.get(claim.root)
    const keeps = (each: Claim): boolean => owners.get(each.root) === each.terminalId
    const better =
      !held ||
      (keeps(claim) && !keeps(held)) ||
      (keeps(claim) === keeps(held) &&
        (claim.since < held.since ||
          (claim.since === held.since && claim.terminalId < held.terminalId)))
    if (better) chosen.set(claim.root, claim)
  }
  return new Map([...chosen].map(([root, claim]) => [root, claim.terminalId]))
}

/** The conflicts of a work: with main, and with each other work, in a stable order. */
export const conflictsOf = (withMain: boolean, others: readonly string[]): WorkConflict[] =>
  [
    ...(withMain ? [{ with: "main" as const }] : []),
    ...others.toSorted().map((terminalId) => ({ with: "work" as const, terminalId })),
  ].slice(0, workLimits.conflicts)
