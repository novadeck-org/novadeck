import { hashOf } from "./hash.js"
import type { HighlightedLine } from "./highlight.js"
import { createHold } from "./hold.js"
import type { Mount, ViewerState } from "./index.js"
import { languageOf } from "./languages.js"

// A read-only change: a repository's files against a base, each a section under a header
// (its path, how it changed, what it added and removed) with its hunks as numbered lines
// that were added, removed or kept for context. Plain text first, then highlighted by each
// file's language as the code viewer does (./highlight.ts, loaded only when needed), the old
// and the new side of a hunk apart. The rows of a long change are made a few at a time, and
// highlighted a hunk at a time, so the pane stays alive while it fills. A new change keeps
// the rows, and their colours, of every file that didn't change, and keeps the place by
// the file and row it was at, not by pixels. Its looks are diff.css's.

export type DiffLine = { readonly kind: "context" | "add" | "remove"; readonly text: string }

export type DiffHunk = {
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  readonly lines: readonly DiffLine[]
}

/**
 * One file. A `binary` file, one that may hold secrets (`held`), or one left out of a long
 * change (`listed`) has no hunks and shows its header with a note.
 */
export type DiffFile = {
  readonly path: string
  readonly oldPath: string | null
  readonly status: "added" | "modified" | "deleted" | "renamed"
  readonly added: number
  readonly removed: number
  readonly binary: boolean
  readonly held: boolean
  readonly listed: boolean
  readonly hunks: readonly DiffHunk[]
}

export type DiffContent = {
  /** What the files are compared with. */
  readonly base: string
  readonly files: readonly DiffFile[]
  /** The change is larger than the files shown. */
  readonly truncated: boolean
}

/**
 * Where the viewer was: the row at its top, by file (its key: its path, and which of the
 * files of that path it is), and the pixels as a fallback; and how far each file's lines
 * were scrolled sideways, for those that were.
 */
type Place = {
  readonly top: number
  readonly lefts: Readonly<Record<string, number>>
  readonly anchor?: Anchor
}

/**
 * The row at the top: its file, and its line there with its kind and text, which find it
 * again when lines come or go above it; and its place among the file's rows, which is where
 * it is when the line is no more nor anything near it. A `row` of -1 is the file itself.
 * The line is the old side's number for a row that is, or was, in the base (a kept or
 * removed line, a hunk's start for its header), which an edit of the working tree leaves
 * as it was, and the new side's for an added line, which edits above move: those are found
 * by their text first.
 */
type Anchor = {
  readonly file: string
  readonly row: number
  readonly offset: number
  readonly line?: number
  readonly kind?: "context" | "add" | "remove" | "hunk"
  readonly text?: string
}

type DiffState = { readonly diff: Place }

const isDiffState = (state: unknown): state is DiffState => {
  const diff = (state as Partial<DiffState> | null)?.diff
  if (typeof diff?.top !== "number" || typeof diff.lefts !== "object" || diff.lefts === null)
    return false
  const { anchor } = diff
  return (
    anchor === undefined ||
    (typeof anchor.file === "string" &&
      typeof anchor.row === "number" &&
      typeof anchor.offset === "number" &&
      (anchor.line === undefined || typeof anchor.line === "number") &&
      (anchor.text === undefined || typeof anchor.text === "string"))
  )
}

/** How many rows are made before the viewer lets the pane draw, and how long it may take. */
const batchRows = 2_000
const batchMs = 12
/** A file with more diff lines than this is left unhighlighted: parsing it costs more than it shows. */
const highlightedLines = 4_000

// Hunks lately highlighted, by language and a hash of their text, so one shown again, as
// by a new viewer of the same change, shows highlighted at once. Kept by the size of the
// text they were parsed from, the one used longest ago going first.
const keptChars = 2_000_000
const highlighted = new Map<string, { runs: readonly HighlightedLine[]; size: number }>()
let highlightedChars = 0

const knownRuns = (key: string): readonly HighlightedLine[] | undefined => {
  const known = highlighted.get(key)
  if (!known) return undefined
  highlighted.delete(key)
  highlighted.set(key, known)
  return known.runs
}

const keepRuns = (key: string, runs: readonly HighlightedLine[], size: number): void => {
  if (size > keptChars / 4) return
  highlighted.set(key, { runs, size })
  highlightedChars += size
  for (const [oldest, each] of highlighted) {
    if (highlightedChars <= keptChars) break
    highlighted.delete(oldest)
    highlightedChars -= each.size
  }
}

const keyOf = (language: string, text: string): string =>
  `${language}\n${text.length}:${hashOf(text)}`

// The files' keys: a file's path, and for each more with the same path, which it is.
const keysOf = (files: readonly DiffFile[]): string[] => {
  const seen = new Map<string, number>()
  return files.map((file) => {
    const count = seen.get(file.path) ?? 0
    seen.set(file.path, count + 1)
    return count === 0 ? file.path : `${file.path}\u0000${count}`
  })
}

const statusNames = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
} as const

const noteOf = (file: DiffFile): string | undefined =>
  file.held
    ? "May hold secrets — not shown."
    : file.binary
      ? "Binary file — not shown."
      : file.listed
        ? "Past this change's size, listed by name."
        : file.hunks.length === 0 && file.status === "renamed"
          ? "Renamed, no changes in it."
          : undefined

// What makes a file as it is drawn: another one is drawn again, the same is kept.
const signatureOf = (file: DiffFile): string => {
  const hunks = file.hunks
    .map(
      (hunk) =>
        `${hunk.oldStart},${hunk.oldCount},${hunk.newStart},${hunk.newCount}\n` +
        hunk.lines.map((line) => `${line.kind[0]}${line.text}`).join("\n"),
    )
    .join("\n\n")
  return [
    file.oldPath,
    file.status,
    file.added,
    file.removed,
    file.binary,
    file.held,
    file.listed,
    hunks.length,
    hashOf(hunks),
  ].join("|")
}

// A hunk's rows, made a few at a time: the old and new line numbers move with the kinds.
type Drawn = {
  readonly hunk: DiffHunk
  readonly body: HTMLElement
  readonly rows: HTMLElement[]
  next: number
  oldLine: number
  newLine: number
  // Highlighted from what was kept, or left plain.
  painted: boolean
}

// The runs of lines in a language, from what was kept or from parsing them.
const runsOf = async (
  language: string,
  lines: readonly string[],
): Promise<{ runs: readonly HighlightedLine[] | null; fresh: boolean }> => {
  const text = lines.join("\n")
  const key = keyOf(language, text)
  const known = knownRuns(key)
  if (known) return { runs: known, fresh: false }
  const { highlightLines } = await import("./highlight.js")
  const runs = await highlightLines(language, lines)
  if (runs) keepRuns(key, runs, text.length)
  return { runs, fresh: true }
}

// The first of `parts`, which run down in order, with something below `base`.
const firstBelow = (parts: ArrayLike<Element>, base: number): number => {
  let low = 0
  let high = parts.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (parts[middle]!.getBoundingClientRect().bottom > base + 1) high = middle
    else low = middle + 1
  }
  return low
}

const sidesOf = (work: Drawn) => ({
  old: work.hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text),
  now: work.hunk.lines.filter((line) => line.kind !== "remove").map((line) => line.text),
})

type Entry = {
  readonly key: string
  readonly file: DiffFile
  readonly signature: string
  readonly section: HTMLElement
  // The file's lines, which scroll sideways on their own; none for a file without hunks.
  readonly scroller: HTMLElement | null
  readonly drawn: Drawn[]
  // Every row is made, and every hunk is highlighted or left plain.
  highlighted: boolean
}

const complete = (entry: Entry): boolean =>
  entry.drawn.every((each) => each.next >= each.hunk.lines.length)

// A part of a file as it is drawn: a hunk's header (`line` -1) or one of its rows.
type Stop = { readonly hunk: number; readonly line: number }

// The part of the file at an index among its drawn headers and rows.
const stopAt = (entry: Entry, index: number): Stop | undefined => {
  let at = 0
  for (const [hunk, each] of entry.drawn.entries()) {
    const count = 1 + each.rows.length
    if (index < at + count) return { hunk, line: index - at - 1 }
    at += count
  }
  return undefined
}

const elementOf = (entry: Entry, { hunk, line }: Stop): Element | undefined =>
  line < 0 ? entry.drawn[hunk]?.body.firstElementChild || undefined : entry.drawn[hunk]?.rows[line]

// What a stop is, to find it again: its line, kind and text.
const describeStop = (
  entry: Entry,
  { hunk, line }: Stop,
): Omit<Anchor, "file" | "row" | "offset"> => {
  const { hunk: data } = entry.drawn[hunk]!
  if (line < 0) return { line: data.oldStart, kind: "hunk", text: "" }
  let oldLine = data.oldStart
  let newLine = data.newStart
  for (const before of data.lines.slice(0, line)) {
    if (before.kind !== "add") oldLine += 1
    if (before.kind !== "remove") newLine += 1
  }
  const { kind, text } = data.lines[line]!
  return { line: kind === "add" ? newLine : oldLine, kind, text }
}

// Where an anchor's line is now: that line, else the nearest one of its side, preferring
// the same kind and text; an added line is found by its text first.
const findStop = (entry: Entry, anchor: Anchor): Stop | undefined => {
  if (anchor.line === undefined || anchor.kind === undefined) return undefined
  let best: Stop | undefined
  let bestScore = Infinity
  const consider = (stop: Stop, score: number): void => {
    if (score >= bestScore) return
    best = stop
    bestScore = score
  }
  for (const [hunk, each] of entry.drawn.entries()) {
    if (anchor.kind === "hunk") {
      consider({ hunk, line: -1 }, Math.abs(each.hunk.oldStart - anchor.line))
      continue
    }
    let oldLine = each.hunk.oldStart
    let newLine = each.hunk.newStart
    for (const [line, row] of each.hunk.lines.entries()) {
      const added = anchor.kind === "add"
      if ((row.kind === "add") === added) {
        const distance = Math.abs((added ? newLine : oldLine) - anchor.line)
        const same = row.text === anchor.text
        consider(
          { hunk, line },
          added
            ? (same ? 0 : 1_000_000) + distance
            : distance * 4 + (row.kind === anchor.kind ? 0 : 2) + (same ? 0 : 1),
        )
      }
      if (row.kind !== "add") oldLine += 1
      if (row.kind !== "remove") newLine += 1
    }
  }
  return best
}

export const mountDiff: Mount<DiffContent> = (element, { content, label, saved }) => {
  const document = element.ownerDocument
  const root = document.createElement("div")
  root.className = "diff-viewer"
  root.setAttribute("role", "region")
  root.setAttribute("aria-label", label)
  // Focusable, so its overflow can be scrolled by keyboard.
  root.tabIndex = 0
  element.append(root)

  let shown = content
  let alive = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let rendered = false
  // The files as drawn, by path and in order.
  let entries = new Map<string, Entry>()
  let order: Entry[] = []
  // The files' keys as they were before the latest change.
  let previousKeys: string[] = []
  // How far each file's lines are scrolled sideways, by key, as their scrolling says: never
  // read back from the page, where a file out of sight has no layout to ask.
  const lefts = new Map<string, number>()
  const byScroller = new WeakMap<Element, Entry>()
  const bySection = new WeakMap<Element, Entry>()

  const el = (tag: string, className: string, text?: string): HTMLElement => {
    const made = document.createElement(tag)
    made.className = className
    if (text !== undefined) made.textContent = text
    return made
  }

  const stats = (file: DiffFile): HTMLElement => {
    const made = el("span", "diff-stats")
    made.append(
      el("span", "diff-added", `+${file.added}`),
      el("span", "diff-removed", `−${file.removed}`),
    )
    return made
  }

  const rowOf = (work: Drawn): HTMLElement => {
    const line = work.hunk.lines[work.next]!
    const row = el("div", "diff-line")
    row.dataset.kind = line.kind
    const before = el("span", "diff-number", line.kind === "add" ? "" : String(work.oldLine))
    const after = el("span", "diff-number", line.kind === "remove" ? "" : String(work.newLine))
    before.setAttribute("aria-hidden", "true")
    after.setAttribute("aria-hidden", "true")
    if (line.kind !== "add") work.oldLine += 1
    if (line.kind !== "remove") work.newLine += 1
    work.next += 1
    row.append(before, after, el("span", "diff-text", line.text))
    work.rows.push(row)
    return row
  }

  // A file's lines are a tab stop only while they overflow sideways: known as their layout
  // is, so a file out of sight, with no layout, costs none.
  const view = document.defaultView
  const sizes = view?.ResizeObserver
    ? new view.ResizeObserver((changes) => {
        for (const { target } of changes) {
          const scroller = target.classList.contains("diff-lines") ? target : target.parentElement
          if (!scroller) continue
          if (scroller.scrollWidth > scroller.clientWidth) scroller.setAttribute("tabindex", "0")
          else scroller.removeAttribute("tabindex")
        }
      })
    : undefined

  const entryOf = (file: DiffFile, key: string): Entry => {
    const section = el("section", "diff-file")
    section.dataset.status = file.status
    const head = el("header", "diff-file-head")
    const name = el("span", "diff-path")
    name.append(el("span", "diff-status", statusNames[file.status]))
    if (file.oldPath !== null && file.status === "renamed")
      name.append(el("code", "diff-old-path", file.oldPath), el("span", "diff-arrow", "→"))
    name.append(el("code", "diff-new-path", file.path))
    head.append(name, stats(file))
    section.append(head)
    const note = noteOf(file)
    if (note) section.append(el("p", "diff-note", note))
    // Each file's lines scroll sideways apart from the viewer, as wide as its widest line,
    // so the file list, the headers and each line's numbers stay where they are.
    let scroller: HTMLElement | null = null
    let lines: HTMLElement | null = null
    if (file.hunks.length > 0) {
      scroller = el("div", "diff-lines")
      scroller.setAttribute("role", "region")
      scroller.setAttribute("aria-label", `${file.path}, changed lines`)
      lines = el("div", "diff-lines-body")
      scroller.append(lines)
      section.append(scroller)
    }
    const drawn = file.hunks.map((hunk): Drawn => {
      const body = el("div", "diff-hunk")
      body.append(
        el(
          "div",
          "diff-hunk-head",
          `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
        ),
      )
      lines!.append(body)
      return {
        hunk,
        body,
        rows: [],
        next: 0,
        oldLine: hunk.oldStart,
        newLine: hunk.newStart,
        painted: false,
      }
    })
    const entry: Entry = {
      key,
      file,
      signature: signatureOf(file),
      section,
      scroller,
      drawn,
      highlighted: false,
    }
    bySection.set(section, entry)
    visible?.observe(section)
    if (scroller) {
      byScroller.set(scroller, entry)
      sizes?.observe(scroller)
      if (scroller.firstElementChild) sizes?.observe(scroller.firstElementChild)
    }
    return entry
  }

  // Where a part of the viewer is in what it scrolls.
  const topOf = (part: Element): number =>
    part.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop

  const stopsOf = (entry: Entry): NodeListOf<Element> =>
    entry.section.querySelectorAll(".diff-hunk-head, .diff-line")

  // What the sideways scrolls are, for the files that are scrolled.
  const leftsNow = (): Record<string, number> =>
    Object.fromEntries(
      order.flatMap((entry) =>
        lefts.get(entry.key) ? [[entry.key, lefts.get(entry.key)!] as const] : [],
      ),
    )

  // The row at the top, by its file and its place among the file's rows, found by halving:
  // only the parts on screen are measured, never a file out of sight.
  const measure = (): Place => {
    const base = root.getBoundingClientRect().top
    const entry =
      order[
        firstBelow(
          order.map((each) => each.section),
          base,
        )
      ]
    if (!entry) return { top: root.scrollTop, lefts: leftsNow() }
    const stops = stopsOf(entry)
    const row = Math.min(firstBelow(stops, base), Math.max(stops.length - 1, 0))
    const at = stops[row] ?? entry.section
    const stop = stopAt(entry, row)
    return {
      top: root.scrollTop,
      lefts: leftsNow(),
      anchor: {
        file: entry.key,
        row,
        offset: at.getBoundingClientRect().top - base,
        ...(stop && describeStop(entry, stop)),
      },
    }
  }

  // Puts the viewer at a place, down to the row and file it names, if they are still there.
  // The sideways scrolls are put back as their files come into view.
  const apply = (place: Place): void => {
    const entry = place.anchor && entries.get(place.anchor.file)
    if (entry && place.anchor) {
      // The line it was at, else the row it was at, else the file.
      let at: Element | undefined = entry.section
      if (place.anchor.row >= 0) {
        const found = findStop(entry, place.anchor)
        const stops = stopsOf(entry)
        at =
          (found && elementOf(entry, found)) ||
          stops[Math.min(place.anchor.row, stops.length - 1)] ||
          entry.section
      }
      root.scrollTop = topOf(at) - place.anchor.offset
    } else root.scrollTop = place.top
  }

  // The latest place measured, which is what it was while the viewer has no size.
  let lastPlace: Place | undefined
  // A place to go back to once the viewer has a size again.
  let pending: Place | undefined
  const placeNow = (): Place =>
    pending ??
    (root.clientHeight ? measure() : { top: lastPlace?.top ?? 0, ...lastPlace, lefts: leftsNow() })

  // The sections change size as their rows come and as the page works out which are on
  // screen, so a place is set again as they do.
  // Held with the browser's own scroll anchoring off, which would otherwise move the place
  // as a file's rows change, and pass for the person's scroll.
  const { hold, release } = createHold(
    root,
    () => order.map((entry) => entry.section),
    () => rendered,
    {
      start: () => root.style.setProperty("overflow-anchor", "none"),
      stop: () => root.style.removeProperty("overflow-anchor"),
    },
  )

  // A place whose file is gone goes to the top of the file that took its place: the next
  // in order, else the one before.
  const settled = (place: Place): Place => {
    const gone = place.anchor?.file
    if (gone === undefined || entries.has(gone)) return place
    const at = previousKeys.indexOf(gone)
    const near = [...previousKeys.slice(at + 1), ...previousKeys.slice(0, at).toReversed()].find(
      (key) => entries.has(key),
    )
    if (at < 0 || near === undefined) return { top: place.top, lefts: place.lefts }
    return { ...place, anchor: { file: near, row: -1, offset: 0 } }
  }

  // Goes to a place now, or when the viewer next has a size.
  const goTo = (asked: Place): void => {
    const place = settled(asked)
    lastPlace = place
    for (const [key, left] of Object.entries(place.lefts))
      if (entries.has(key)) lefts.set(key, left)
    if (root.clientHeight) {
      pending = undefined
      hold(() => apply(place))
    } else {
      release()
      pending = place
    }
  }

  const paint = (rows: readonly HTMLElement[], lines: readonly (HighlightedLine | undefined)[]) => {
    rows.forEach((row, index) => {
      const runs = lines[index]
      const text = row.lastElementChild
      if (!runs || !text) return
      text.replaceChildren(
        ...runs.map((run) => {
          if (!run.classes) return run.text
          const span = document.createElement("span")
          span.className = run.classes
          span.textContent = run.text
          return span
        }),
      )
    })
  }

  let highlighting = false

  // A hunk's old side (context and removed lines) and new side (context and added) are
  // parsed apart, so a string or comment opened on one doesn't colour the other.
  // Puts runs of the two sides on a hunk's rows: a removed line takes the old side's, any
  // other the new side's.
  const paintHunk = (
    work: Drawn,
    before: readonly HighlightedLine[] | null,
    after: readonly HighlightedLine[] | null,
  ): void => {
    let oldAt = 0
    let newAt = 0
    paint(
      work.rows,
      work.hunk.lines.map((line) => {
        const found = line.kind === "remove" ? before?.[oldAt] : after?.[newAt]
        if (line.kind !== "add") oldAt += 1
        if (line.kind !== "remove") newAt += 1
        return found
      }),
    )
  }

  const highlightHunk = async (language: string, work: Drawn): Promise<boolean> => {
    const { old, now } = sidesOf(work)
    const before = await runsOf(language, old)
    const after = await runsOf(language, now)
    paintHunk(work, before.runs, after.runs)
    work.painted = true
    return before.fresh || after.fresh
  }

  // Each file by its language, a hunk at a time with the page drawing between; a file
  // whose parser fails, or in no language, or too long, stays plain, and the rest go on.
  const highlightEntry = async (entry: Entry): Promise<void> => {
    const language = languageOf(entry.file.path)
    const total = entry.file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
    try {
      if (!language || total > highlightedLines) return
      // The hunks seen before first, as a changed file's unchanged ones are.
      for (const work of entry.drawn) {
        const { old, now } = sidesOf(work)
        const before = knownRuns(keyOf(language, old.join("\n")))
        const after = knownRuns(keyOf(language, now.join("\n")))
        if (before && after) {
          paintHunk(work, before, after)
          work.painted = true
        }
      }
      for (const work of entry.drawn) {
        if (work.painted) continue
        if (!alive || entries.get(entry.key) !== entry) return
        // eslint-disable-next-line no-await-in-loop -- One hunk at a time, so the pane keeps drawing.
        const parsed = await highlightHunk(language, work)
        // eslint-disable-next-line no-await-in-loop -- Lets the pane draw between hunks.
        if (parsed) await new Promise((resolve) => setTimeout(resolve, 0))
      }
    } catch {
      // Plain text is the fallback when a parser can't load.
    } finally {
      entry.highlighted = true
    }
  }

  const highlight = async (): Promise<void> => {
    if (highlighting) return
    highlighting = true
    try {
      for (;;) {
        if (!alive) return
        const next = order.find((entry) => !entry.highlighted && complete(entry))
        if (!next) return
        // eslint-disable-next-line no-await-in-loop -- One file at a time.
        await highlightEntry(next)
      }
    } finally {
      highlighting = false
    }
  }

  // Rows a batch at a time, in the order of the files, the first before this returns.
  const step = (): void => {
    timer = undefined
    if (!alive) return
    const until = Date.now() + batchMs
    let made = 0
    for (const entry of order) {
      for (const work of entry.drawn) {
        if (work.next >= work.hunk.lines.length) continue
        const fragment = document.createDocumentFragment()
        while (work.next < work.hunk.lines.length && made < batchRows) {
          fragment.append(rowOf(work))
          made += 1
          if (made % 200 === 0 && Date.now() > until) made = batchRows
        }
        work.body.append(fragment)
        if (made >= batchRows) break
      }
      if (made >= batchRows) break
    }
    rendered = order.every(complete)
    if (!rendered) timer = setTimeout(step, 0)
    void highlight()
  }

  const build = (): void => {
    clearTimeout(timer)
    // A file that is as it was keeps its rows, with their colours and what is left to draw.
    const before = entries
    previousKeys = order.map((entry) => entry.key)
    entries = new Map()
    const keys = keysOf(shown.files)
    order = shown.files.map((file, index) => {
      const key = keys[index]!
      const known = before.get(key)
      const entry = known && known.signature === signatureOf(file) ? known : entryOf(file, key)
      entries.set(key, entry)
      return entry
    })
    for (const key of lefts.keys()) if (!entries.has(key)) lefts.delete(key)
    for (const gone of before.values())
      if (entries.get(gone.key) !== gone) {
        if (gone.scroller) {
          sizes?.unobserve(gone.scroller)
          if (gone.scroller.firstElementChild) sizes?.unobserve(gone.scroller.firstElementChild)
        }
        visible?.unobserve(gone.section)
      }

    // The widest line number, which the gutters are as wide as.
    const digits = Math.max(
      1,
      ...shown.files.flatMap((file) =>
        file.hunks.map(
          (hunk) =>
            String(Math.max(hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount)).length,
        ),
      ),
    )
    root.style.setProperty("--diff-digits", String(digits))

    const list = el("nav", "diff-files")
    list.setAttribute("aria-label", "Changed files")
    for (const entry of order) {
      const { file, section } = entry
      const button = document.createElement("button")
      button.className = "diff-file-link"
      button.type = "button"
      button.setAttribute(
        "aria-label",
        `${file.path}, ${file.added} added, ${file.removed} removed`,
      )
      button.append(el("span", "diff-file-name", file.path), stats(file))
      // Only this viewer scrolls: the page's other scrollers stay where they are.
      button.addEventListener("click", () => hold(() => (root.scrollTop = topOf(section))))
      list.append(button)
    }

    const parts: Element[] = []
    if (order.length === 0)
      parts.push(el("p", "diff-note diff-empty", `No changes against ${shown.base}`))
    else {
      if (order.length > 1) parts.push(list)
      parts.push(...order.map((entry) => entry.section))
    }
    if (shown.truncated)
      parts.push(el("p", "diff-note diff-truncated", "This change is larger than shown."))
    // Only what changed is put in or taken out: a file that stays is not detached, which
    // would lose where its lines are scrolled and lay it out again.
    const wanted = new Set<Element>(parts)
    for (let at = root.children.length - 1; at >= 0; at--)
      if (!wanted.has(root.children[at]!)) root.children[at]!.remove()
    parts.forEach((part, index) => {
      if (root.children[index] !== part) root.insertBefore(part, root.children[index] ?? null)
    })
    rendered = false
    step()
  }

  const restore = (state: ViewerState): void => {
    if (isDiffState(state)) goTo(state.diff)
  }

  // The place the person is at, as they scroll, for a viewer that has no size to measure,
  // and how far each file is scrolled sideways: from their scroll events, which don't
  // bubble, so caught on the way down.
  let frame: number | undefined
  const scrolled = (event: Event): void => {
    const entry = byScroller.get(event.target as Element)
    if (entry) lefts.set(entry.key, (event.target as HTMLElement).scrollLeft)
    if (frame !== undefined || !root.clientHeight) return
    frame = view?.requestAnimationFrame(() => {
      frame = undefined
      if (alive && root.clientHeight) lastPlace = measure()
    })
  }
  root.addEventListener("scroll", scrolled, { passive: true, capture: true })

  // A file's sideways scroll is put back as it comes into view, never before: a file out of
  // sight has no layout, and asking for one costs the layout of all of them.
  const visible = view?.IntersectionObserver
    ? new view.IntersectionObserver(
        (changes) => {
          for (const { target, isIntersecting } of changes) {
            const entry = bySection.get(target)
            const left = entry && lefts.get(entry.key)
            if (isIntersecting && entry?.scroller && left && entry.scroller.scrollLeft !== left)
              entry.scroller.scrollLeft = left
          }
        },
        { root, rootMargin: "200px 0px" },
      )
    : undefined

  // The place a viewer without a size was to go back to, once it has one.
  let wakeFrame: number | undefined
  const wake = view?.ResizeObserver
    ? new view.ResizeObserver(() => {
        if (!pending || !root.clientHeight || wakeFrame !== undefined) return
        // Not in the observer's own callback, which would resize what it watches.
        wakeFrame = view.requestAnimationFrame(() => {
          wakeFrame = undefined
          if (!alive || !pending || !root.clientHeight) return
          const place = pending
          pending = undefined
          hold(() => apply(place))
        })
      })
    : undefined
  wake?.observe(root)

  build()
  if (isDiffState(saved)) restore(saved)

  return {
    update: (next) => {
      if (next === shown) return
      shown = next
      // The new rows keep where the person was: the same file and row, where they still are.
      const place = placeNow()
      build()
      goTo(place)
    },
    state: () => ({ diff: placeNow() }) satisfies DiffState as unknown as ViewerState,
    restore,
    // A change has no lines to jump to.
    jumpTo: () => undefined,
    focus: () => root.focus({ preventScroll: true }),
    destroy: () => {
      alive = false
      clearTimeout(timer)
      if (frame !== undefined) view?.cancelAnimationFrame(frame)
      root.removeEventListener("scroll", scrolled, { capture: true })
      if (wakeFrame !== undefined) view?.cancelAnimationFrame(wakeFrame)
      visible?.disconnect()
      wake?.disconnect()
      sizes?.disconnect()
      release()
      root.remove()
    },
  }
}
