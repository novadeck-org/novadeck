import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react"

import { useOpen } from "./use-open"

// A long text in the log shows its first lines when it runs past this many, and a key opens the
// rest: another agent's message, and a tool call's command and what it printed.
const foldedAt = 5
const shownLines = foldedAt - 1

export type Fold = {
  // The id of what folds, for the key to control.
  readonly id: string
  // Whether the text runs past the fold, and whether the person opened it.
  readonly folds: boolean
  readonly open: boolean
  readonly setOpen: (open: boolean) => void
  // How many lines the text takes at its width, whether cut short or not, and how many of them
  // the cut hides.
  readonly lines: number
  readonly more: number
  // What folds wears while it's cut short: `data-folded` and the height it shows.
  readonly cut: {
    readonly "data-folded"?: true
    readonly style?: React.CSSProperties
  }
}

// Folds the element given the ref to its first lines once it takes more than `foldedAt`,
// measured at its width, and again as that or `text` changes. The element is clamped while folded,
// so what it holds is watched too. Whether the person opened it is kept by `key` (see ./use-open).
export const useFold = <T extends HTMLElement>(
  text: string,
  key: string,
): readonly [RefObject<T | null>, Fold] => {
  const ref = useRef<T>(null)
  const [lines, setLines] = useState(0)
  const [open, setOpen] = useOpen(key, false)
  const id = useId()
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => {
      const height = parseFloat(getComputedStyle(element).lineHeight)
      setLines(height > 0 ? Math.round(element.scrollHeight / height) : 0)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const watch = new ResizeObserver(measure)
    watch.observe(element)
    if (element.firstElementChild) watch.observe(element.firstElementChild)
    return () => watch.disconnect()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- New text is new lines to count.
  }, [text])
  const folds = lines > foldedAt
  const cut =
    folds && !open
      ? {
          "data-folded": true as const,
          style: { "--_shown": `calc(${shownLines} * var(--_lh))` } as React.CSSProperties,
        }
      : {}
  return [ref, { id, folds, open, setOpen, lines, more: lines - shownLines, cut }]
}

// An agent's reply folds once it takes more than this many lines at its width (Preferences >
// Experimental > Fold long replies): about one reply in eight of Claude Code's, one in a hundred
// of Codex's, and none yet of Antigravity's, which run short.
export const replyFoldedAt = 40
// It shows at least this many of its first lines, and at most this many.
const replyAtLeast = 3
const replyAtMost = 12

// A top-level part of a reply's words as laid out: where it starts and ends, from the top of
// the words, in pixels, and whether it's a heading.
export type Part = { readonly top: number; readonly bottom: number; readonly heading: boolean }

/**
 * How many of a long reply's lines show while it's folded: its first parts, up to the end of one
 * that isn't a heading and at least `replyAtLeast` lines down, and the blank line after it, where
 * the fade falls. A part that would take it past `replyAtMost` isn't begun: it ends at the part
 * before, or, where even the first runs past, cuts that short. Nothing laid out shows the least.
 */
export const replyShown = (parts: readonly Part[], lineHeight: number): number => {
  let end = 0
  for (const part of parts) {
    if (part.bottom > replyAtMost * lineHeight) {
      if (end === 0) return replyAtMost
      break
    }
    if (part.heading) continue
    end = part.bottom
    if (end >= replyAtLeast * lineHeight) break
  }
  if (end === 0) return replyAtLeast
  return Math.min(replyAtMost, Math.ceil(end / lineHeight) + 1)
}

// The top-level parts of the Markdown the element holds, as laid out.
const partsOf = (element: HTMLElement): readonly Part[] => {
  const top = element.getBoundingClientRect().top
  const words = element.querySelector(":scope > .markdown")
  return [...(words?.children ?? [])].map((child) => {
    const box = child.getBoundingClientRect()
    return { top: box.top - top, bottom: box.bottom - top, heading: /^H[1-6]$/.test(child.tagName) }
  })
}

/**
 * `useFold` for an agent's reply in the element `ref` holds, which folds once `on`: past
 * `replyFoldedAt` lines, to its first parts (see `replyShown`) rather than a set number of lines.
 * Until then it measures nothing.
 */
export const useReplyFold = (
  ref: RefObject<HTMLElement | null>,
  text: string,
  key: string,
  on: boolean,
): Fold => {
  const [laid, setLaid] = useState({ lines: 0, shown: 0 })
  const [open, setOpen] = useOpen(key, false)
  const id = useId()
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !on) return
    const measure = (): void => {
      const height = parseFloat(getComputedStyle(element).lineHeight)
      const lines = height > 0 ? Math.round(element.scrollHeight / height) : 0
      const shown = lines > replyFoldedAt ? replyShown(partsOf(element), height) : 0
      setLaid((was) => (was.lines === lines && was.shown === shown ? was : { lines, shown }))
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const watch = new ResizeObserver(measure)
    watch.observe(element)
    if (element.firstElementChild) watch.observe(element.firstElementChild)
    return () => watch.disconnect()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- New text is new lines to count.
  }, [ref, text, on])
  const folds = on && laid.lines > replyFoldedAt
  const cut =
    folds && !open
      ? {
          "data-folded": true as const,
          style: { "--_shown": `calc(${laid.shown} * var(--_lh))` } as React.CSSProperties,
        }
      : {}
  return { id, folds, open, setOpen, lines: laid.lines, more: laid.lines - laid.shown, cut }
}

/**
 * Whether the element `ref` holds has been out of sight since it was drawn: once it is, it stays
 * so. Where nothing can tell (no IntersectionObserver), it is from the start.
 */
export const useOutOfSight = (ref: RefObject<HTMLElement | null>): boolean => {
  const [away, setAway] = useState(() => typeof IntersectionObserver === "undefined")
  useEffect(() => {
    const element = ref.current
    if (away || !element) return
    const watch = new IntersectionObserver(([entry]) => {
      if (entry && !entry.isIntersecting) setAway(true)
    })
    watch.observe(element)
    return () => watch.disconnect()
  }, [ref, away])
  return away
}

// The key under a folded text: how many more lines it has, or that it shows them all.
export const MoreKey = ({ fold }: { readonly fold: Fold }): React.JSX.Element | null =>
  fold.folds ? (
    <button
      type="button"
      className="chat-key chat-more nodrag nopan"
      aria-expanded={fold.open}
      aria-controls={fold.id}
      onClick={() => fold.setOpen(!fold.open)}
    >
      {fold.open ? "show less" : `… ${fold.more} more lines`}
    </button>
  ) : null
