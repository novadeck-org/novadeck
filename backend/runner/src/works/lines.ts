import { workLimits, type WorkConflict, type WorkFile } from "@novadeck/protocol"

// The pure parts of Works: adding up lines and putting a work together. Nothing here runs git.

/** The lines one file gained and lost. */
export type Lines = { readonly added: number; readonly removed: number }

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

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The files a work lists: the changed ones in path order, at most `workLimits.files` (past
 * which the conflicting ones stay, then the biggest), each
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
    .toSorted(([a], [b]) => byPath(a, b))
    .map(([path, lines]) => ({ path, lines, unread: unread ? (unread.get(path) ?? none) : lines }))
  // Where more changed than are listed, the ones to keep are the conflicting, then the biggest.
  const size = (lines: Lines): number => lines.added + lines.removed
  const kept =
    all.length <= workLimits.files
      ? all
      : all
          .toSorted(
            (a, b) =>
              Number(conflicting.has(b.path)) - Number(conflicting.has(a.path)) ||
              size(b.lines) - size(a.lines) ||
              byPath(a.path, b.path),
          )
          .slice(0, workLimits.files)
          .toSorted((a, b) => byPath(a.path, b.path))
  return {
    files: kept.map(({ path, lines, unread: read }) => ({
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

/** The conflicts of a work: with main, and with each other work (by root), in a stable order. */
export const conflictsOf = (
  withMain: boolean,
  others: readonly { readonly root: string; readonly terminalId: string | null }[],
): WorkConflict[] =>
  [
    ...(withMain ? [{ with: "main" as const }] : []),
    ...others
      .toSorted((a, b) => byPath(a.root, b.root))
      .map(({ root, terminalId }) => ({ with: "work" as const, root, terminalId })),
  ].slice(0, workLimits.conflicts)
