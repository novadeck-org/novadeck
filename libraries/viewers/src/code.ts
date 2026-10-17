import type { HighlightedLine } from "./highlight.js"
import type { Mount, ViewerState } from "./index.js"
import { createKept } from "./kept.js"
import { languageOf } from "./languages.js"

export type { HighlightedLine, Run } from "./highlight.js"
export { languageOf, type Language } from "./languages.js"

// A read-only listing of code: numbered lines from any first line, plain text at once,
// then highlighted once its language's parser has loaded (./highlight.ts, loaded only
// when needed), and a range of lines emphasized, which it first scrolls into view.
// Its looks are code.css's.

export type CodeContent = {
  readonly lines: readonly string[]
  /** The number of the first line. */
  readonly firstLine: number
  /** The file's name, which tells its language when `language` doesn't. */
  readonly path?: string
  readonly language?: string
  /** The lines to emphasize, by number, both ends included. */
  readonly emphasis?: { readonly from: number; readonly to: number }
}

// The lines split into runs by kind of token, or null when the language isn't one the
// viewer highlights.
export const highlightLines = async (
  language: string,
  lines: readonly string[],
): Promise<readonly HighlightedLine[] | null> =>
  (await import("./highlight.js")).highlightLines(language, lines)

// Listings lately highlighted, so one shown again shows highlighted at once. By language
// and a hash of the text, so a key never holds the text, and only under a size past which
// keeping them costs more than parsing again.
const highlighted = createKept<readonly HighlightedLine[]>(24)
const keptSize = 200_000

// A 53-bit hash of the text (cyrb53): a key that changes with it.
const hashOf = (text: string): string => {
  let first = 0xdeadbeef
  let second = 0x41c6ce57
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at)
    first = Math.imul(first ^ code, 2654435761)
    second = Math.imul(second ^ code, 1597334677)
  }
  first =
    Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909)
  second =
    Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909)
  return (4294967296 * (2097151 & second) + (first >>> 0)).toString(36)
}

const keyOf = (language: string, lines: readonly string[]): string | null => {
  const text = lines.join("\n")
  return text.length > keptSize ? null : `${language}\n${text.length}:${hashOf(text)}`
}

// The language the content names, or its file's.
const languageFor = (content: CodeContent): string | undefined =>
  content.language ?? (content.path === undefined ? undefined : languageOf(content.path))

// The same lines emphasized, at the same place in the listing.
const sameEmphasis = (one: CodeContent, other: CodeContent): boolean =>
  one.firstLine === other.firstLine &&
  one.emphasis?.from === other.emphasis?.from &&
  one.emphasis?.to === other.emphasis?.to

const sameLines = (one: readonly string[], other: readonly string[]): boolean =>
  one === other || (one.length === other.length && one.every((line, at) => line === other[at]))

// Where the listing was scrolled, and in which file: a place in one file means nothing
// in another.
type CodeState = {
  readonly code: { readonly top: number; readonly left: number; readonly path?: string }
}

const isCodeState = (state: unknown): state is CodeState => {
  const code = (state as Partial<CodeState> | null)?.code
  return typeof code?.top === "number" && typeof code.left === "number"
}

export const mountCode: Mount<CodeContent> = (element, { content, label, saved }) => {
  // The element may live in another window's document, as an undocked pane does.
  const document = element.ownerDocument
  const root = document.createElement("div")
  root.className = "code-viewer"
  root.setAttribute("role", "region")
  root.setAttribute("aria-label", label)
  // Focusable, so its overflow can be scrolled by keyboard.
  root.tabIndex = 0
  element.append(root)

  let shown = content
  let rows: HTMLElement[] = []
  // Which listing a highlighting that finishes is for: only the latest paints.
  let listing = 0

  const paint = (lines: readonly HighlightedLine[]): void => {
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

  // Each line as plain text, as the listing first shows.
  const plain = (): void => {
    rows.forEach((row, index) => row.lastElementChild?.replaceChildren(shown.lines[index] ?? ""))
  }

  const highlight = (): void => {
    const current = ++listing
    const language = languageFor(shown)
    if (!language) return plain()
    const { lines } = shown
    const key = keyOf(language, lines)
    const known = key === null ? undefined : highlighted.get(key)
    if (known) return paint(known)
    highlightLines(language, lines).then(
      (found) => {
        if (found && key !== null) highlighted.keep(key, found)
        // A language it has no parser for reads as plain text.
        if (current !== listing) return
        if (found) paint(found)
        else plain()
      },
      // Plain text is the fallback when a parser can't load.
      () => {
        if (current === listing) plain()
      },
    )
  }

  const emphasize = (): void => {
    const { emphasis, firstLine } = shown
    rows.forEach((row, index) => {
      const number = firstLine + index
      row.toggleAttribute(
        "data-emphasized",
        emphasis !== undefined && number >= emphasis.from && number <= emphasis.to,
      )
    })
  }

  const render = (): void => {
    rows = shown.lines.map((line, index) => {
      const row = document.createElement("div")
      const number = document.createElement("span")
      number.setAttribute("aria-hidden", "true")
      number.textContent = String(shown.firstLine + index)
      const text = document.createElement("span")
      text.textContent = line
      row.append(number, text)
      return row
    })
    root.replaceChildren(...rows)
    emphasize()
    highlight()
  }

  // The line a quarter of the way down, so what comes before it shows too.
  const reveal = (line: number): void => {
    const row = rows[Math.min(Math.max(line - shown.firstLine, 0), rows.length - 1)]
    if (row) root.scrollTop = Math.max(0, row.offsetTop - root.clientHeight / 4)
  }

  // The emphasized lines, unless they show already.
  const revealEmphasis = (): void => {
    const { emphasis, firstLine } = shown
    const first = emphasis && rows[emphasis.from - firstLine]
    const last = emphasis && rows[Math.min(emphasis.to - firstLine, rows.length - 1)]
    // Out of sight it has no size to tell what shows.
    if (!emphasis || !first || !last || !root.clientHeight) return
    const top = root.scrollTop
    const bottom = top + root.clientHeight
    if (first.offsetTop < top || last.offsetTop + last.offsetHeight > bottom) reveal(emphasis.from)
  }

  // A place set before the listing has its size, as when it mounts out of sight (a parked
  // terminal) or while its pane settles, is set again as the size arrives, until a moment
  // after it first has one, or until the person, or anything else, scrolls it.
  let holding: (() => void) | undefined
  const hold = (place: () => void): void => {
    holding?.()
    // Where it last put the listing: a scroll anywhere else is someone else's.
    let placed = { top: -1, left: -1 }
    const put = (): void => {
      place()
      placed = { top: root.scrollTop, left: root.scrollLeft }
    }
    put()
    const Observer = document.defaultView?.ResizeObserver
    if (!Observer) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // Moved since it put it there, unless only cut short as the listing shrank: a scroll
    // whose event may not have come yet.
    const moved = (): boolean => {
      const { scrollTop: top, scrollLeft: left } = root
      const { scrollHeight, clientHeight, scrollWidth, clientWidth } = root
      const clampedTop = top < placed.top && top >= scrollHeight - clientHeight - 1
      const clampedLeft = left < placed.left && left >= scrollWidth - clientWidth - 1
      return (top !== placed.top && !clampedTop) || (left !== placed.left && !clampedLeft)
    }
    const observer = new Observer(() => {
      if (moved()) return holding?.()
      put()
      if (root.clientHeight && timer === undefined) timer = setTimeout(() => holding?.(), 1000)
    })
    const release = (): void => holding?.()
    const scrolled = (): void => {
      if (moved()) release()
    }
    const inputs = ["wheel", "pointerdown", "keydown", "touchstart"] as const
    holding = () => {
      observer.disconnect()
      clearTimeout(timer)
      for (const input of inputs) root.removeEventListener(input, release)
      root.removeEventListener("scroll", scrolled)
      holding = undefined
    }
    for (const input of inputs) root.addEventListener(input, release, { passive: true })
    root.addEventListener("scroll", scrolled, { passive: true })
    observer.observe(root)
  }

  // A place in this file.
  const isPlace = (state: ViewerState | undefined): state is CodeState & ViewerState =>
    isCodeState(state) && state.code.path === shown.path

  const restore = (state: ViewerState): void => {
    if (!isPlace(state)) return
    const { top, left } = state.code
    hold(() => {
      root.scrollTop = top
      root.scrollLeft = left
    })
  }

  render()
  if (isPlace(saved)) restore(saved)
  else if (shown.emphasis) hold(revealEmphasis)

  return {
    update: (next) => {
      const previous = shown
      shown = next
      if (previous.firstLine === next.firstLine && sameLines(previous.lines, next.lines)) {
        emphasize()
        // The same lines in another language highlight again.
        if (languageFor(previous) !== languageFor(next)) highlight()
      } else {
        // A place still to be set out of sight is set once the listing has a size; on
        // sight, the new lines keep where it is.
        if (root.clientHeight) holding?.()
        const { scrollTop, scrollLeft } = root
        render()
        root.scrollTop = scrollTop
        root.scrollLeft = scrollLeft
      }
      // Other lines emphasized are lines to show, as when its agent points elsewhere.
      if (next.emphasis && !sameEmphasis(previous, next)) hold(revealEmphasis)
    },
    state: () =>
      ({
        code: {
          top: root.scrollTop,
          left: root.scrollLeft,
          ...(shown.path === undefined ? {} : { path: shown.path }),
        },
      }) satisfies CodeState as unknown as ViewerState,
    restore,
    // Out of sight, it lands once the listing has a size.
    jumpTo: (target) => {
      if ("line" in target) return hold(() => reveal(target.line))
      // The line the offset falls in, counting each line's break.
      let left = target.offset
      const index = shown.lines.findIndex((line) => (left -= line.length + 1) < 0)
      const line = shown.firstLine + (index < 0 ? shown.lines.length - 1 : index)
      hold(() => reveal(line))
    },
    focus: () => root.focus({ preventScroll: true }),
    destroy: () => {
      listing++
      holding?.()
      root.remove()
    },
  }
}
