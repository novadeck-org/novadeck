import type { ChatBlock } from "@novadeck/core/conversation/turns"
import { useCallback, useMemo, useRef, useState } from "react"

import {
  heldAt,
  holdHeight,
  startRows,
  turnStarts,
  type Held,
  type StartRow,
  type TurnStart,
} from "./turn-holds"

const same = (a: Held | null, b: Held | null): boolean =>
  a === b || (a !== null && b !== null && a.id === b.id && a.offset === b.offset)

// Which of the person's prompts holds the top of the log (see `heldAt`), and the prompt unfolded
// in place, which stays open only while it holds the top. `measure` reads the log's rows as they
// stand, for the chat to call as the log grows or is resized; `scrolled` places the hold from the
// rows last read, as scrolling moves none of them in the log's content.
export const useTurnHold = (
  blocks: readonly ChatBlock[],
  compact: boolean,
): {
  readonly starts: readonly TurnStart[]
  readonly held: Held | null
  readonly peek: string | null
  readonly setPeek: (id: string | null) => void
  readonly measure: (scroller: HTMLElement | null) => void
  readonly scrolled: (scroller: HTMLElement | null) => void
} => {
  const starts = useMemo(() => turnStarts(blocks), [blocks])
  const [held, setHeld] = useState<Held | null>(null)
  const [peek, setPeek] = useState<string | null>(null)
  // The rows last read, and the starts they were read for.
  const rows = useRef<{ readonly of: readonly TurnStart[]; readonly rows: readonly StartRow[] }>({
    of: [],
    rows: [],
  })
  const place = useCallback(
    (scroller: HTMLElement, read: readonly StartRow[]): void => {
      const next = heldAt(read, scroller.scrollTop, holdHeight(compact))
      setHeld((before) => (same(before, next) ? before : next))
      setPeek((open) => (open !== null && open !== next?.id ? null : open))
    },
    [compact],
  )
  const measure = useCallback(
    (scroller: HTMLElement | null): void => {
      if (!scroller) return
      rows.current = { of: starts, rows: startRows(scroller, starts) }
      place(scroller, rows.current.rows)
    },
    [starts, place],
  )
  // Rows not read since the turns changed (where nothing watches the log's size) are read first.
  const scrolled = useCallback(
    (scroller: HTMLElement | null): void => {
      if (!scroller) return
      if (rows.current.of !== starts) measure(scroller)
      else place(scroller, rows.current.rows)
    },
    [starts, measure, place],
  )
  return { starts, held, peek, setPeek, measure, scrolled }
}
