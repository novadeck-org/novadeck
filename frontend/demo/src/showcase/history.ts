import type {
  ChangedFile,
  ChangeFileDiff,
  ChangeLayer,
  ChangesContent,
  DiffHunk,
} from "@novadeck/core/items"

// A small git for the demo: a checkout's files at the start (main), then the steps that
// followed, oldest first, each a commit or, last, the work not committed yet. From the texts
// of every version it reads what the runner reads from git: the layers with each file's lines,
// and one file's hunks and both sides for any selection of layers. Nothing is invented but the
// texts, so counts, hunks and facts agree with each other.

/** Files by path, each its whole text. */
export type Files = Readonly<Record<string, string>>

export type Step = {
  /** A commit's hash, or "uncommitted". */
  readonly id: string
  readonly subject: string
  /** When it was made, null for the uncommitted work. */
  readonly time: number | null
  /** The files this step wrote: added where they were not there, else replaced. */
  readonly set?: Files
  readonly remove?: readonly string[]
  /** Files renamed: the new path and the old one (its text is `set`'s, else the old one's). */
  readonly move?: Readonly<Record<string, string>>
  /** Files the runner lists by name and never reads. */
  readonly held?: readonly string[]
  readonly binary?: readonly string[]
  /** A merge the runner shows against its first parent (its git can't merge in memory). */
  readonly firstParent?: boolean
}

export type History = {
  readonly root: string
  /** The main branch the checkout is measured against. */
  readonly base: string
  /** The files of main. */
  readonly start: Files
  /** Oldest first. */
  readonly steps: readonly Step[]
  /** Files whose change passes the bounds: named, with no lines. */
  readonly big?: readonly string[]
  /** More changed than is listed. */
  readonly truncated?: boolean
}

// ── Lines ──────────────────────────────────────────────────────────────────────────────

const linesOf = (text: string): string[] => {
  if (text === "") return []
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

const key = (line: string): string => line.replaceAll(/\s+/g, "")

/** The pairs of lines (by index) the longest common run of two lists keeps. */
const common = (a: readonly string[], b: readonly string[]): [number, number][] => {
  const table = Array.from({ length: a.length + 1 }, () =>
    Array.from<number>({ length: b.length + 1 }).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  const pairs: [number, number][] = []
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1
    else j += 1
  }
  return pairs
}

const contextLines = 3

/** The hunks of a diff of two texts, with three lines of context, as git prints them. */
const hunksOf = (before: string, after: string): DiffHunk[] => {
  const a = linesOf(before)
  const b = linesOf(after)
  type Op = { kind: "context" | "add" | "remove"; text: string; old: number; now: number }
  const ops: Op[] = []
  let i = 0
  let j = 0
  for (const [pi, pj] of [...common(a, b), [a.length, b.length] as const]) {
    for (; i < pi; i += 1) ops.push({ kind: "remove", text: a[i]!, old: i + 1, now: j })
    for (; j < pj; j += 1) ops.push({ kind: "add", text: b[j]!, old: i, now: j + 1 })
    if (pi < a.length) ops.push({ kind: "context", text: a[pi]!, old: pi + 1, now: pj + 1 })
    i = pi + 1
    j = pj + 1
  }
  const changed = ops.flatMap((op, at) => (op.kind === "context" ? [] : [at]))
  const hunks: DiffHunk[] = []
  let at = 0
  while (at < changed.length) {
    let last = changed[at]!
    const first = changed[at]!
    while (at + 1 < changed.length && changed[at + 1]! - last <= contextLines * 2 + 1) {
      at += 1
      last = changed[at]!
    }
    at += 1
    const from = Math.max(0, first - contextLines)
    const to = Math.min(ops.length - 1, last + contextLines)
    const slice = ops.slice(from, to + 1)
    const old = slice.filter((op) => op.kind !== "add")
    const now = slice.filter((op) => op.kind !== "remove")
    hunks.push({
      oldStart: old[0]?.old ?? slice[0]?.old ?? 0,
      oldCount: old.length,
      newStart: now[0]?.now ?? slice[0]?.now ?? 0,
      newCount: now.length,
      lines: slice.map(({ kind, text }) => ({ kind, text })),
    })
  }
  return hunks
}

/**
 * Lines added and removed, and the lines that only changed whitespace: in a block of removed
 * lines followed by added ones, those that match once blanks are ignored are counted apart.
 */
const counts = (
  before: string,
  after: string,
): { added: number; removed: number; reindented: number } => {
  let added = 0
  let removed = 0
  let reindented = 0
  for (const hunk of hunksOf(before, after)) {
    for (let at = 0; at < hunk.lines.length;) {
      const old: string[] = []
      const now: string[] = []
      for (; hunk.lines[at]?.kind === "remove"; at += 1) old.push(hunk.lines[at]!.text)
      for (; hunk.lines[at]?.kind === "add"; at += 1) now.push(hunk.lines[at]!.text)
      if (old.length === 0 && now.length === 0) {
        at += 1
        continue
      }
      const same = common(old.map(key), now.map(key)).filter(([i]) => key(old[i]!) !== "").length
      added += now.length - same
      removed += old.length - same
      reindented += same
    }
  }
  return { added, removed, reindented }
}

// ── Versions ───────────────────────────────────────────────────────────────────────────

type Flags = ReadonlyMap<string, "secret" | "binary">

const apply = (files: Files, step: Step): Files => {
  const next: Record<string, string> = { ...files }
  for (const [path, from] of Object.entries(step.move ?? {})) {
    next[path] = step.set?.[path] ?? next[from] ?? ""
    delete next[from]
  }
  for (const path of step.remove ?? []) delete next[path]
  for (const [path, text] of Object.entries(step.set ?? {})) next[path] = text
  for (const path of [...(step.held ?? []), ...(step.binary ?? [])]) next[path] ??= ""
  return next
}

/** Every version: main's, then after each step. */
const versions = (history: History): Files[] => {
  const all: Files[] = [history.start]
  for (const step of history.steps) all.push(apply(all.at(-1)!, step))
  return all
}

const flagsOf = (history: History): Flags =>
  new Map([
    ...history.steps.flatMap((step) => (step.held ?? []).map((path) => [path, "secret"] as const)),
    ...history.steps.flatMap((step) =>
      (step.binary ?? []).map((path) => [path, "binary"] as const),
    ),
  ])

const statusOf = (
  before: string | undefined,
  after: string | undefined,
  moved: boolean,
): ChangedFile["status"] =>
  moved ? "renamed" : before === undefined ? "added" : after === undefined ? "deleted" : "modified"

/** The files a step changed, with their lines. */
const filesOf = (before: Files, after: Files, step: Step, flags: Flags): ChangedFile[] => {
  const moves = step.move ?? {}
  const gone = new Set(Object.values(moves))
  const paths = new Set([...Object.keys(before), ...Object.keys(after)])
  const out: ChangedFile[] = []
  for (const path of [...paths].toSorted()) {
    if (gone.has(path) && !(path in after)) continue
    const old = moves[path] ?? path
    const was = before[old]
    const now = after[path]
    if (was === now && old === path) continue
    const flag = flags.get(path)
    const lines =
      flag === "binary" ? { added: 0, removed: 0, reindented: 0 } : counts(was ?? "", now ?? "")
    out.push({
      path,
      oldPath: old === path ? null : old,
      status: statusOf(was, now, old !== path),
      ...lines,
      binary: flag === "binary",
      secret: flag === "secret",
    })
  }
  return out
}

/** The layers of a checkout, newest first, as the runner would list them. */
export const contentOf = (history: History): ChangesContent => {
  const all = versions(history)
  const flags = flagsOf(history)
  const layers = history.steps
    .map((step, at): ChangeLayer => {
      const files = filesOf(all[at]!, all[at + 1]!, step, flags)
      return {
        id: step.id,
        kind: step.id === "uncommitted" ? "uncommitted" : "commit",
        subject: step.subject,
        time: step.time,
        added: files.reduce((sum, file) => sum + file.added, 0),
        removed: files.reduce((sum, file) => sum + file.removed, 0),
        files,
        truncated: false,
        ...(step.firstParent && { firstParent: true }),
      }
    })
    .toReversed()
  return {
    kind: "changes",
    root: history.root,
    base: history.base,
    layers,
    truncated: history.truncated ?? false,
  }
}

/** The files the layers selected changed as one range: the net of it, as git lists it. */
export const rangeOf = (history: History, selected: readonly string[]): ChangedFile[] => {
  const all = versions(history)
  const ends = history.steps.flatMap((step, at) => (selected.includes(step.id) ? [at] : []))
  if (ends.length === 0) return []
  const oldest = ends[0]!
  const newest = ends.at(-1)!
  // Renames across the range, back to the names the files had where it began.
  const chain: Record<string, string> = {}
  for (const step of history.steps.slice(oldest, newest + 1))
    for (const [now, was] of Object.entries(step.move ?? {})) {
      chain[now] = chain[was] ?? was
      delete chain[was]
    }
  const flags = flagsOf(history)
  return filesOf(
    all[oldest]!,
    all[newest + 1]!,
    { id: "", subject: "", time: null, move: chain },
    flags,
  )
}

/** One file as the layers selected changed it: a run for each group that follows on. */
export const diffOf = (
  history: History,
  path: string,
  selected: readonly string[],
): ChangeFileDiff => {
  const all = versions(history)
  const flags = flagsOf(history)
  // Newest first, as the list shows them.
  const order = history.steps.map((step, at) => ({ id: step.id, at })).toReversed()
  // The selection is one range, the layers between its ends taken in.
  const ends = order.flatMap((layer, place) => (selected.includes(layer.id) ? [place] : []))
  const groups = ends.length === 0 ? [] : [order.slice(ends[0], ends.at(-1)! + 1)]
  const runs: ChangeFileDiff["runs"][number][] = []
  for (const group of groups) {
    const newest = group[0]!.at
    const oldest = group.at(-1)!.at
    // Where the file was before the range, following renames back through it.
    let old = path
    for (let at = newest; at >= oldest; at -= 1) old = history.steps[at]!.move?.[old] ?? old
    const was = all[oldest]![old]
    const now = all[newest + 1]![path]
    if (was === now && old === path) continue
    const flag = flags.get(path)
    const lines =
      flag === "binary" ? { added: 0, removed: 0, reindented: 0 } : counts(was ?? "", now ?? "")
    const file: ChangedFile = {
      path,
      oldPath: old === path ? null : old,
      status: statusOf(was, now, old !== path),
      ...lines,
      binary: flag === "binary",
      secret: flag === "secret",
    }
    const big = history.big?.includes(path) ?? false
    const shown = !flag && !big
    runs.push({
      layers: group.map((layer) => layer.id),
      file,
      big,
      badName: false,
      hunks: shown ? hunksOf(was ?? "", now ?? "") : [],
      before: shown && was !== undefined ? was : null,
      after: shown && now !== undefined ? now : null,
    })
  }
  return { runs }
}
