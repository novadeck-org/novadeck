import type { PreviewHunk, WorkPreviewWork } from "@novadeck/core/works"
import { tokenDiff, type Marks } from "@novadeck/viewers/facts"

// A file as it would be once the agents' work merges onto main, as the rows the preview draws:
// main's lines (context), each agent's changes carried onto them (add rows, a changed line
// keeping main's number, the lines it removed folded away), clashes (two agents changing
// overlapping lines of main: one version shows), and changes that don't apply (main rewrote
// their lines since). Pure: what the person left out, picked and unfolded comes in as `view`.

/** One agent's work on the file: what the runner told, and who it is. */
export type Agent = Pick<WorkPreviewWork, "status" | "changedAt" | "hunks"> & {
  /** The work's root: what names it. */
  readonly key: string
  /** The terminal's handle; undefined for a worktree with no open terminal. */
  readonly handle: string | undefined
  /** What names it to the person: `@moth`, else its branch. */
  readonly label: string
}

/** A clash version the person picked: an agent's key or `main`, valid until anyone writes again. */
export type Choice = { readonly who: string; readonly seen: number }

export type View = {
  /** The agents left out of the merge, by key. */
  readonly left: ReadonlySet<string>
  /** The versions picked at clashes, by clash. */
  readonly picks: Readonly<Record<string, Choice>>
}

export type Row = {
  readonly kind: "context" | "add" | "remove"
  /** Main's line number; none for a line only an agent has. */
  readonly n: number | null
  readonly text: string
  readonly marks: Marks
  /** Where its text is in `sourcesOf`' lines, for its syntax colours. */
  readonly src: number
  /** For an agent's line: what names it among the agent's lines (see `writtenSince`). */
  readonly sig?: string
}

/** Main's lines an agent removed, folded into a line that unfolds into them. */
export type Cut = { readonly t: "cut"; readonly id: string; readonly rows: readonly Row[] }

/** A stretch of unchanged lines, folded. */
export type Fold = { readonly t: "fold"; readonly id: string; readonly rows: readonly Row[] }

export type Clash = {
  readonly key: string
  /** Everyone who changes the lines, the one shown among them (or `main`). */
  readonly members: readonly Agent[]
  readonly shown: Agent | "main"
}

/** An agent's change under its head. A clash held for `main` is a block of no agent's. */
export type Block = {
  readonly t: "block"
  readonly id: string
  readonly agent: Agent | undefined
  /** The change's place among the agent's changes that apply, for its facts. */
  readonly index: number
  readonly clash: Clash | undefined
  readonly rows: readonly (Row | Cut)[]
}

/** A change that doesn't apply: main's lines stand, its version waits behind a button. */
export type Stale = {
  readonly t: "stale"
  readonly id: string
  readonly agent: Agent
  /** The main line it started at, and how many lines it changed. */
  readonly line: number
  readonly count: number
  readonly version: readonly Row[]
  readonly rows: readonly Row[]
}

export type Piece = { readonly t: "row"; readonly row: Row } | Fold | Block | Stale

export type Layout = {
  readonly pieces: readonly Piece[]
  readonly added: number
  readonly removed: number
  /** The changes of the agents merged that don't apply. */
  readonly stale: number
}

/** Longer unchanged stretches fold, keeping a few lines at each end. */
export const foldOver = 8
const foldKeep = 3

/** The lines of a text, without the one a final newline would start. */
export const linesOf = (text: string | null): string[] => {
  if (text === null || text === "") return []
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/**
 * Every line the preview may draw, for its syntax colours: main's, then each agent's hunks'. A
 * line is found by its number there: main's is its own number less one; `offsets` gives where
 * each of an agent's hunks starts.
 */
export const sourcesOf = (
  main: string | null,
  agents: readonly Agent[],
): {
  readonly texts: readonly string[]
  readonly offsets: ReadonlyMap<string, readonly number[]>
} => {
  const texts = linesOf(main)
  const offsets = new Map<string, number[]>()
  for (const agent of agents)
    offsets.set(
      agent.key,
      agent.hunks.map((hunk) => {
        const start = texts.length
        texts.push(...hunk.lines)
        return start
      }),
    )
  return { texts, offsets }
}

type Located = { readonly agent: Agent; readonly hunk: PreviewHunk; readonly at: number }

// The lines of main a change spans, as an inclusive range: an insertion sits between two lines.
const spanOf = ({ at, removed }: PreviewHunk): readonly [number, number] =>
  removed === 0 ? [at - 0.5, at - 0.5] : [at, at + removed - 1]

const overlap = (a: PreviewHunk, b: PreviewHunk): boolean => {
  const [a1, a2] = spanOf(a)
  const [b1, b2] = spanOf(b)
  return a1 <= b2 && b1 <= a2
}

/** The clusters of changes that overlap one another, by their lines of main, in order. */
const clustersOf = (changes: readonly Located[]): Located[][] => {
  const sorted = changes.toSorted((a, b) => a.hunk.at - b.hunk.at)
  const clusters: Located[][] = []
  for (const change of sorted) {
    const joined = clusters.filter((cluster) =>
      cluster.some((each) => overlap(each.hunk, change.hunk)),
    )
    const merged = [...joined.flat(), change]
    for (const cluster of joined) clusters.splice(clusters.indexOf(cluster), 1)
    clusters.push(merged.toSorted((a, b) => a.hunk.at - b.hunk.at))
  }
  return clusters.toSorted((a, b) => a[0]!.hunk.at - b[0]!.hunk.at)
}

/** The agent last to write among those, the one whose change a clash shows unless picked. */
export const lastWriter = (agents: readonly Agent[]): Agent =>
  agents.toSorted((a, b) => b.changedAt - a.changedAt || (a.key < b.key ? -1 : 1))[0]!

/**
 * The version a clash shows: the picked one while nobody has written since it was picked (a
 * write to the file moves `changedAt` on), else whoever wrote last: a clash follows its writer.
 */
export const shownAt = (members: readonly Agent[], pick: Choice | undefined): Agent | "main" => {
  const latest = Math.max(...members.map((each) => each.changedAt))
  if (pick && latest <= pick.seen) {
    if (pick.who === "main") return "main"
    const picked = members.find((each) => each.key === pick.who)
    if (picked) return picked
  }
  return lastWriter(members)
}

const clashBase = (members: readonly Agent[]): string =>
  members
    .map((each) => each.key)
    .toSorted()
    .join("+")

/** Marks of the changed words of a line that replaces main's, none where most of it changed. */
const marksOf = (was: string, now: string): Marks => tokenDiff(was, now, 0.5)?.after ?? []

/**
 * What names each line an agent's changes that apply hold: its text and which of its equal
 * lines it is, whatever the line's place, so a line is the same line after others are added
 * before it. By hunk.
 */
const agentSigs = (agent: Agent): ReadonlyMap<PreviewHunk, readonly string[]> => {
  const seen = new Map<string, number>()
  return new Map(
    agent.hunks
      .filter((hunk) => hunk.applies)
      .map((hunk) => [
        hunk,
        hunk.lines.map((text) => {
          const count = seen.get(text) ?? 0
          seen.set(text, count + 1)
          return `${text}#${count}`
        }),
      ]),
  )
}

/** An agent's lines of a change, as its rows: those over main's lines keep their numbers. */
const changeRows = (
  main: readonly string[],
  agent: Agent,
  hunk: PreviewHunk,
  start: number,
  sigs: readonly string[],
): { readonly rows: (Row | Cut)[]; readonly removed: number } => {
  const paired = Math.min(hunk.removed, hunk.lines.length)
  const rows: (Row | Cut)[] = hunk.lines.map((text, at) => {
    const number = at < paired ? hunk.at + at : null
    return {
      kind: "add",
      n: number,
      text,
      marks: number === null ? [] : marksOf(main[number - 1] ?? "", text),
      src: start + at,
      sig: sigs[at]!,
    }
  })
  const gone = hunk.removed - paired
  if (gone > 0)
    rows.push({
      t: "cut",
      id: `cut:${agent.key}:${hunk.at}`,
      rows: Array.from({ length: gone }, (_, at) => {
        const n = hunk.at + paired + at
        return { kind: "remove", n, text: main[n - 1] ?? "", marks: [], src: n - 1 }
      }),
    })
  return { rows, removed: hunk.removed }
}

const contextRow = (main: readonly string[], n: number): Row => ({
  kind: "context",
  n,
  text: main[n - 1] ?? "",
  marks: [],
  src: n - 1,
})

/** Main's lines from `from` to `to`: as rows, a long stretch folded but for a few lines at its ends. */
const stretch = (main: readonly string[], from: number, to: number): Piece[] => {
  const rows = Array.from({ length: Math.max(0, to - from + 1) }, (_, at) =>
    contextRow(main, from + at),
  )
  if (rows.length <= foldOver) return rows.map((row) => ({ t: "row", row }))
  return [
    ...rows.slice(0, foldKeep).map((row): Piece => ({ t: "row", row })),
    { t: "fold", id: `fold:${from}`, rows: rows.slice(foldKeep, rows.length - foldKeep) },
    ...rows.slice(rows.length - foldKeep).map((row): Piece => ({ t: "row", row })),
  ]
}

/** The lines of the agents that are left in, laid over main's. */
export const layoutPreview = (
  main: string | null,
  agents: readonly Agent[],
  view: View,
  sources = sourcesOf(main, agents),
): Layout => {
  const lines = linesOf(main)
  const merged = agents.filter((agent) => !view.left.has(agent.key))
  const located = (applies: boolean): Located[] =>
    merged.flatMap((agent) =>
      agent.hunks.flatMap((hunk, at) => (hunk.applies === applies ? [{ agent, hunk, at }] : [])),
    )
  const applying = located(true)
  const sigs = new Map(merged.map((agent) => [agent.key, agentSigs(agent)]))
  const indexOf = (agent: Agent, hunk: PreviewHunk): number =>
    agent.hunks.filter((each) => each.applies).indexOf(hunk)

  type Event = { readonly at: number; readonly piece: Block | Stale; readonly to: number }
  const events: Event[] = []
  let added = 0
  let removed = 0
  const block = (
    change: Located,
    id: string,
    clash: Clash | undefined,
  ): { event: Event; piece: Block } => {
    const { agent, hunk } = change
    const start = sources.offsets.get(agent.key)?.[change.at] ?? 0
    const made = changeRows(lines, agent, hunk, start, sigs.get(agent.key)?.get(hunk) ?? [])
    added += hunk.lines.length
    removed += made.removed
    const piece: Block = {
      t: "block",
      id,
      agent,
      index: indexOf(agent, hunk),
      clash,
      rows: made.rows,
    }
    return { piece, event: { at: hunk.at, piece, to: hunk.at + hunk.removed - 1 } }
  }

  // Clashes of the same agents are told apart by their order in the file.
  const ordinals = new Map<string, number>()
  for (const cluster of clustersOf(applying)) {
    const members = [...new Map(cluster.map((each) => [each.agent.key, each.agent])).values()]
    if (members.length < 2) {
      const [only] = cluster
      events.push(block(only!, `change:${only!.agent.key}:${only!.hunk.at}`, undefined).event)
      continue
    }
    const base = clashBase(members)
    const count = ordinals.get(base) ?? 0
    ordinals.set(base, count + 1)
    const key = `${base}#${count}`
    const shown = shownAt(members, view.picks[key])
    const clash: Clash = { key, members, shown }
    if (shown === "main") {
      const first = cluster[0]!.hunk
      const last = Math.max(...cluster.map((each) => each.hunk.at + each.hunk.removed - 1))
      const piece: Block = {
        t: "block",
        id: `clash:${key}`,
        agent: undefined,
        index: 0,
        clash,
        rows: Array.from({ length: Math.max(0, last - first.at + 1) }, (_, at) =>
          contextRow(lines, first.at + at),
        ),
      }
      events.push({ at: first.at, piece, to: last })
      continue
    }
    const mine = cluster.filter((each) => each.agent === shown)
    for (const [at, change] of mine.entries())
      events.push(
        block(change, `change:${shown.key}:${change.hunk.at}`, at === 0 ? clash : undefined).event,
      )
  }

  let stale = 0
  for (const change of located(false)) {
    stale += 1
    const { agent, hunk } = change
    const start = sources.offsets.get(agent.key)?.[change.at] ?? 0
    const to = hunk.at + hunk.removed - 1
    events.push({
      at: hunk.at,
      to,
      piece: {
        t: "stale",
        id: `stale:${agent.key}:${hunk.at}`,
        agent,
        line: hunk.at,
        count: hunk.removed,
        version: hunk.lines.map((text, at) => ({
          kind: "add",
          n: null,
          text,
          marks: [],
          src: start + at,
        })),
        rows: Array.from({ length: hunk.removed }, (_, at) => contextRow(lines, hunk.at + at)),
      },
    })
  }

  const pieces: Piece[] = []
  let next = 1
  for (const event of events.toSorted((a, b) => a.at - b.at || a.to - b.to)) {
    pieces.push(...stretch(lines, next, event.at - 1))
    if (event.piece.t === "stale") {
      // Main's lines it stood for, but those already drawn.
      const drawn = Math.max(0, next - event.at)
      pieces.push({ ...event.piece, rows: event.piece.rows.slice(drawn) })
    } else pieces.push(event.piece)
    next = Math.max(next, event.to + 1, event.at)
  }
  pieces.push(...stretch(lines, next, lines.length))
  return { pieces, added, removed, stale }
}

/**
 * The lines each agent has in the file that weren't there before: what its latest write
 * changed, as the lines it now holds that it did not, in the file's order.
 */
export const writtenSince = (
  before: ReadonlyMap<string, readonly string[]>,
  after: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> =>
  new Map(
    [...after].flatMap(([agent, sigs]) => {
      const was = new Set(before.get(agent))
      const written = sigs.filter((sig) => !was.has(sig))
      return written.length > 0 ? [[agent, written] as const] : []
    }),
  )

/** The lines each agent has in the file, by what names them (the ones that apply), in order. */
export const sigsOf = (agents: readonly Agent[]): ReadonlyMap<string, readonly string[]> =>
  new Map(agents.map((agent) => [agent.key, [...agentSigs(agent).values()].flat()]))
