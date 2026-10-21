import { createHold } from "./hold.js"
import type { Mount, ViewerState } from "./index.js"
import { languageOf } from "./languages.js"

// A read-only change: a repository's files against a base, each a section under a header
// (its path, how it changed, what it added and removed) with its hunks as numbered lines
// that were added, removed or kept for context. Plain text first, then highlighted by each
// file's language as the code viewer does (./highlight.ts, loaded only when needed). The
// rows of a long change are made a few at a time, so the pane stays alive while it fills.
// Its looks are diff.css's.

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

type DiffState = { readonly diff: { readonly top: number; readonly left: number } }

const isDiffState = (state: unknown): state is DiffState => {
  const diff = (state as Partial<DiffState> | null)?.diff
  return typeof diff?.top === "number" && typeof diff.left === "number"
}

/** How many rows are made before the viewer lets the pane draw, and how long it may take. */
const batchRows = 2_000
const batchMs = 12
/** A file with more lines than this is left unhighlighted: parsing it would cost more than it shows. */
const highlightedLines = 4_000

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
        : undefined

type Rows = { readonly file: DiffFile; readonly hunks: readonly (readonly HTMLElement[])[] }

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
  // Which change the rows and highlighting under way are of: only the latest goes on.
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let rendered = false

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

  // A hunk still to be drawn: its rows are made a few at a time, the old and new line
  // numbers moving with the kinds of lines.
  type Work = {
    readonly hunk: DiffHunk
    readonly body: HTMLElement
    readonly into: HTMLElement[]
    next: number
    oldLine: number
    newLine: number
  }

  const rowOf = (work: Work): HTMLElement => {
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
    work.into.push(row)
    return row
  }

  const build = (): void => {
    const current = ++generation
    clearTimeout(timer)
    rendered = false
    const sections: HTMLElement[] = []
    const rows: Rows[] = []
    // Where each hunk's rows go, in the order they are made.
    const work: Work[] = []

    const list = el("nav", "diff-files")
    list.setAttribute("aria-label", "Changed files")
    shown.files.forEach((file, index) => {
      const section = el("section", "diff-file")
      section.dataset.status = file.status
      section.id = `diff-file-${index}`
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
      const hunks: HTMLElement[][] = []
      file.hunks.forEach((hunk) => {
        const body = el("div", "diff-hunk")
        body.append(
          el(
            "div",
            "diff-hunk-head",
            `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
          ),
        )
        section.append(body)
        const into: HTMLElement[] = []
        hunks.push(into)
        work.push({
          hunk,
          body,
          into,
          next: 0,
          oldLine: hunk.oldStart,
          newLine: hunk.newStart,
        })
      })
      rows.push({ file, hunks })
      sections.push(section)

      const entry = document.createElement("button")
      entry.className = "diff-file-link"
      entry.type = "button"
      entry.append(el("span", "diff-file-name", file.path), stats(file))
      entry.addEventListener("click", () => {
        section.scrollIntoView({ block: "start" })
      })
      list.append(entry)
    })

    const parts: HTMLElement[] = []
    if (shown.files.length === 0)
      parts.push(el("p", "diff-note diff-empty", `No changes against ${shown.base}`))
    else {
      if (shown.files.length > 1) parts.push(list)
      parts.push(...sections)
    }
    if (shown.truncated)
      parts.push(el("p", "diff-note diff-truncated", "This change is larger than shown."))
    root.replaceChildren(...parts)

    // Rows a batch at a time, the first before this returns.
    let at = 0
    const step = (): void => {
      if (current !== generation) return
      const until = Date.now() + batchMs
      let made = 0
      while (at < work.length && made < batchRows) {
        const item = work[at]!
        const fragment = document.createDocumentFragment()
        while (item.next < item.hunk.lines.length && made < batchRows) {
          fragment.append(rowOf(item))
          made += 1
          if (made % 200 === 0 && Date.now() > until) made = batchRows
        }
        item.body.append(fragment)
        if (item.next >= item.hunk.lines.length) at += 1
      }
      if (at < work.length) {
        timer = setTimeout(step, 0)
        return
      }
      rendered = true
      void highlight(current, rows)
    }
    step()
  }

  const paint = (
    hunk: readonly HTMLElement[],
    runs: readonly (readonly { text: string; classes: string }[])[],
  ): void => {
    hunk.forEach((row, index) => {
      const line = runs[index]
      const text = row.lastElementChild
      if (!line || !text) return
      text.replaceChildren(
        ...line.map((run) => {
          if (!run.classes) return run.text
          const span = document.createElement("span")
          span.className = run.classes
          span.textContent = run.text
          return span
        }),
      )
    })
  }

  // Each file by its language, a hunk at a time; a file in no language, or too long, stays plain.
  const highlight = async (current: number, rows: readonly Rows[]): Promise<void> => {
    try {
      for (const { file, hunks } of rows) {
        const language = languageOf(file.path)
        if (
          !language ||
          file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) > highlightedLines
        )
          continue
        // eslint-disable-next-line no-await-in-loop -- One hunk at a time, so the pane keeps drawing.
        const { highlightLines } = await import("./highlight.js")
        for (const [index, hunk] of file.hunks.entries()) {
          if (current !== generation) return
          // eslint-disable-next-line no-await-in-loop -- One hunk at a time, so the pane keeps drawing.
          const found = await highlightLines(
            language,
            hunk.lines.map((line) => line.text),
          )
          if (current !== generation) return
          if (found) paint(hunks[index]!, found)
        }
        // Lets the pane draw between files.
        // eslint-disable-next-line no-await-in-loop -- One hunk at a time, so the pane keeps drawing.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    } catch {
      // Plain text is the fallback when a parser can't load.
    }
  }

  // The sections change size as their rows come and as the page works out which are on
  // screen, so a place is set again as they do.
  const { hold, release } = createHold(
    root,
    () => [...root.querySelectorAll(".diff-file")],
    () => rendered,
  )

  const restore = (state: ViewerState): void => {
    if (!isDiffState(state)) return
    const { top, left } = state.diff
    hold(() => {
      root.scrollTop = top
      root.scrollLeft = left
    })
  }

  build()
  if (isDiffState(saved)) restore(saved)

  return {
    update: (next) => {
      if (next === shown) return
      shown = next
      // The new rows keep where the person was; out of sight, a place still to be set is kept.
      if (!root.clientHeight) return build()
      release()
      const { scrollTop: top, scrollLeft: left } = root
      build()
      hold(() => {
        root.scrollTop = top
        root.scrollLeft = left
      })
    },
    state: () =>
      ({
        diff: { top: root.scrollTop, left: root.scrollLeft },
      }) satisfies DiffState as unknown as ViewerState,
    restore,
    // A change has no lines to jump to.
    jumpTo: () => undefined,
    focus: () => root.focus({ preventScroll: true }),
    destroy: () => {
      generation += 1
      clearTimeout(timer)
      release()
      root.remove()
    },
  }
}
