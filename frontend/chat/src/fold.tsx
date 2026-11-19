import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react"

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
  // How many lines the text takes at its width, whether cut short or not.
  readonly lines: number
  // What folds wears while it's cut short: `data-folded` and the height it shows.
  readonly cut: {
    readonly "data-folded"?: true
    readonly style?: React.CSSProperties
  }
}

// Folds the element given the ref to its first lines once it takes more than `foldedAt`,
// measured at its width, and again as that or `text` changes. The element is clamped while folded,
// so what it holds is watched too.
export const useFold = <T extends HTMLElement>(
  text: string,
): readonly [RefObject<T | null>, Fold] => {
  const ref = useRef<T>(null)
  const [lines, setLines] = useState(0)
  const [open, setOpen] = useState(false)
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
  return [ref, { id, folds, open, setOpen, lines, cut }]
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
      {fold.open ? "show less" : `… ${fold.lines - shownLines} more lines`}
    </button>
  ) : null
