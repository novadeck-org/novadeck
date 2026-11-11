import type { ChatBlock } from "@novadeck/core/conversation/turns"
import { useCallback, useMemo, useState } from "react"

import { heldAt, holdHeight, startRows, turnStarts, type Held, type TurnStart } from "./turn-holds"

const same = (a: Held | null, b: Held | null): boolean =>
  a === b || (a !== null && b !== null && a.id === b.id && a.offset === b.offset)

// Which of the person's prompts holds the top of the log (see `heldAt`), and the prompt unfolded
// in place, which stays open only while it holds the top. `measure` reads the log's rows as they
// stand, for the chat to call as the log scrolls, grows or is resized.
export const useTurnHold = (
  blocks: readonly ChatBlock[],
  compact: boolean,
): {
  readonly starts: readonly TurnStart[]
  readonly held: Held | null
  readonly peek: string | null
  readonly setPeek: (id: string | null) => void
  readonly measure: (scroller: HTMLElement | null) => void
} => {
  const starts = useMemo(() => turnStarts(blocks), [blocks])
  const [held, setHeld] = useState<Held | null>(null)
  const [peek, setPeek] = useState<string | null>(null)
  const measure = useCallback(
    (scroller: HTMLElement | null): void => {
      if (!scroller) return
      const next = heldAt(startRows(scroller, starts), scroller.scrollTop, holdHeight(compact))
      setHeld((before) => (same(before, next) ? before : next))
      setPeek((open) => (open !== null && open !== next?.id ? null : open))
    },
    [starts, compact],
  )
  return { starts, held, peek, setPeek, measure }
}
