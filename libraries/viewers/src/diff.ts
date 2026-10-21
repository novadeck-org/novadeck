import { hashOf } from "./hash.js"
import type { HighlightedLine } from "./highlight.js"
import { createHold } from "./hold.js"
import type { Mount, ViewerState } from "./index.js"
import { createKept } from "./kept.js"
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
 * Where the viewer was: the row at its top, by file, and the pixels as a fallback; and how
 * far each file's lines were scrolled sideways, by path, for those that were.
 */
type Place = {
  readonly top: number
  readonly lefts: Readonly<Record<string, number>>
  readonly anchor?: { readonly path: string; readonly row: number; readonly offset: number }
}

type DiffState = { readonly diff: Place }

const isDiffState = (state: unknown): state is DiffState => {
  const diff = (state as Partial<DiffState> | null)?.diff
  if (typeof diff?.top !== "number" || typeof diff.lefts !== "object" || diff.lefts === null)
    return false
  const { anchor } = diff
  return (
    anchor === undefined ||
    (typeof anchor.path === "string" &&
      typeof anchor.row === "number" &&
      typeof anchor.offset === "number")
  )
}

/** How many rows are made before the viewer lets the pane draw, and how long it may take. */
const batchRows = 2_000
const batchMs = 12
/** A file with more diff lines than this is left unhighlighted: parsing it costs more than it shows. */
const highlightedLines = 4_000

// Hunks lately highlighted, by language and a hash of their text, so one shown again, as
// by a new viewer of the same change, shows highlighted at once.
const highlighted = createKept<readonly HighlightedLine[]>(256)
const keptSize = 100_000

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
}

// The runs of lines in a language, from what was kept or from parsing them.
const runsOf = async (
  language: string,
  lines: readonly string[],
): Promise<{ runs: readonly HighlightedLine[] | null; fresh: boolean }> => {
  const text = lines.join("\n")
  const key = text.length > keptSize ? null : `${language}\n${text.length}:${hashOf(text)}`
  const known = key === null ? undefined : highlighted.get(key)
  if (known) return { runs: known, fresh: false }
  const { highlightLines } = await import("./highlight.js")
  const runs = await highlightLines(language, lines)
  if (runs && key !== null) highlighted.keep(key, runs)
  return { runs, fresh: true }
}

type Entry = {
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

  const entryOf = (file: DiffFile): Entry => {
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
      // Focusable, so its overflow can be scrolled by keyboard.
      scroller.tabIndex = 0
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
      return { hunk, body, rows: [], next: 0, oldLine: hunk.oldStart, newLine: hunk.newStart }
    })
    return { file, signature: signatureOf(file), section, scroller, drawn, highlighted: false }
  }

  // Where a part of the viewer is in what it scrolls.
  const topOf = (part: Element): number =>
    part.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop

  const stopsOf = (entry: Entry): Element[] => [
    ...entry.section.querySelectorAll(".diff-hunk-head, .diff-line"),
  ]

  // The row at the top, by its file and its place among the file's rows.
  const measure = (): Place => {
    const base = root.getBoundingClientRect().top
    const lefts = Object.fromEntries(
      order.flatMap((entry) =>
        entry.scroller && entry.scroller.scrollLeft > 0
          ? [[entry.file.path, entry.scroller.scrollLeft] as const]
          : [],
      ),
    )
    // The first file with something below the top: they run down in order.
    let low = 0
    let high = order.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (order[middle]!.section.getBoundingClientRect().bottom > base + 1) high = middle
      else low = middle + 1
    }
    const entry = order[low]
    if (!entry) return { top: root.scrollTop, lefts }
    const stops = stopsOf(entry)
    const found = stops.findIndex((stop) => stop.getBoundingClientRect().bottom > base + 1)
    const row = Math.max(found, 0)
    const at = stops[row] ?? entry.section
    return {
      top: root.scrollTop,
      lefts,
      anchor: { path: entry.file.path, row, offset: at.getBoundingClientRect().top - base },
    }
  }

  // Puts the viewer at a place; the row and file it names, if they are still there.
  const apply = (place: Place): void => {
    const entry = place.anchor && entries.get(place.anchor.path)
    if (entry && place.anchor) {
      const stops = stopsOf(entry)
      const at = stops[Math.min(place.anchor.row, stops.length - 1)] ?? entry.section
      root.scrollTop = topOf(at) - place.anchor.offset
    } else root.scrollTop = place.top
    for (const each of order)
      if (each.scroller) each.scroller.scrollLeft = place.lefts[each.file.path] ?? 0
  }

  // The latest place measured, which is what it was while the viewer has no size.
  let lastPlace: Place | undefined
  const placeNow = (): Place =>
    root.clientHeight ? measure() : (lastPlace ?? { top: 0, lefts: {} })

  // The sections change size as their rows come and as the page works out which are on
  // screen, so a place is set again as they do.
  const { hold, release } = createHold(
    root,
    () => order.map((entry) => entry.section),
    () => rendered,
  )

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
  const highlightHunk = async (language: string, work: Drawn): Promise<boolean> => {
    const { lines } = work.hunk
    const old = lines.filter((line) => line.kind !== "add")
    const now = lines.filter((line) => line.kind !== "remove")
    const before = await runsOf(
      language,
      old.map((line) => line.text),
    )
    const after = await runsOf(
      language,
      now.map((line) => line.text),
    )
    let oldAt = 0
    let newAt = 0
    const runs = lines.map((line) => {
      const fromOld = line.kind === "remove"
      const found = fromOld ? before.runs?.[oldAt] : after.runs?.[newAt]
      if (line.kind !== "add") oldAt += 1
      if (line.kind !== "remove") newAt += 1
      return found
    })
    paint(work.rows, runs)
    return before.fresh || after.fresh
  }

  // Each file by its language, a hunk at a time with the page drawing between; a file
  // whose parser fails, or in no language, or too long, stays plain, and the rest go on.
  const highlightEntry = async (entry: Entry): Promise<void> => {
    const language = languageOf(entry.file.path)
    const total = entry.file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
    try {
      if (!language || total > highlightedLines) return
      for (const work of entry.drawn) {
        if (!alive || entries.get(entry.file.path) !== entry) return
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
    entries = new Map()
    order = shown.files.map((file) => {
      const known = before.get(file.path)
      const entry = known && known.signature === signatureOf(file) ? known : entryOf(file)
      entries.set(file.path, entry)
      return entry
    })

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
    root.replaceChildren(...parts)
    rendered = false
    step()
  }

  const restore = (state: ViewerState): void => {
    if (!isDiffState(state)) return
    const place = state.diff
    lastPlace = place
    hold(() => apply(place))
  }

  // The place the person is at, as they scroll, for a viewer that has no size to measure.
  let frame: number | undefined
  const view = document.defaultView
  const scrolled = (): void => {
    if (frame !== undefined || !root.clientHeight) return
    frame = view?.requestAnimationFrame(() => {
      frame = undefined
      if (alive && root.clientHeight) lastPlace = measure()
    })
  }
  // A file's lines scrolling sideways don't bubble: caught on the way down.
  root.addEventListener("scroll", scrolled, { passive: true, capture: true })

  build()
  if (isDiffState(saved)) restore(saved)

  return {
    update: (next) => {
      if (next === shown) return
      shown = next
      // The new rows keep where the person was: the same file and row, where they still are.
      const place = placeNow()
      lastPlace = place
      release()
      build()
      hold(() => apply(place))
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
      release()
      root.remove()
    },
  }
}
