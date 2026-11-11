import type { ChatBlock } from "@novadeck/core/conversation/turns"

// The turns of a conversation, as the record delimits them: a turn starts at a prompt the person
// sent (a `user` block), or at the line Novadeck's doorbell typed (a `doorbell` block, which the
// record writes only when the ring itself started a turn). A message the doorbell delivers into a
// turn already running, another agent's or the person's Inbox answer, is no item of the record
// but part of the turn, so it starts nothing. A prompt still on its way (a bubble) is not a block,
// so it starts nothing until the record holds it.
export type TurnStart = {
  readonly id: string
  // The person's own prompt: only these hold the top of the log.
  readonly mine: boolean
}

export const turnStarts = (blocks: readonly ChatBlock[]): readonly TurnStart[] =>
  blocks.flatMap((block): TurnStart[] =>
    block.kind === "user"
      ? [{ id: block.id, mine: true }]
      : block.kind === "doorbell"
        ? [{ id: block.id, mine: false }]
        : [],
  )

// The prompt that started the latest turn, if it is the person's: the one whose mark speaks for
// the window's state. A turn a ring started has none.
export const currentPrompt = (blocks: readonly ChatBlock[]): string | null => {
  const latest = turnStarts(blocks).at(-1)
  return latest?.mine ? latest.id : null
}

// A turn's start as laid out in the log: its row's top and bottom, in the scroller's content.
export type StartRow = TurnStart & { readonly top: number; readonly bottom: number }

// The prompt that holds the top of a log scrolled to `top`, and how far the next turn's start has
// pushed it up: the turn at the top is the last one started at or above it; its prompt holds the
// top once the row is wholly above it, until the next start, anyone's, arrives under the held
// line (`height` tall) and pushes it out, as a sticky section header is.
export type Held = { readonly id: string; readonly offset: number }

export const heldAt = (rows: readonly StartRow[], top: number, height: number): Held | null => {
  const index = rows.findLastIndex((row) => row.top <= top)
  const row = rows[index]
  if (!row?.mine || row.bottom > top) return null
  const next = rows[index + 1]
  return { id: row.id, offset: next ? Math.min(0, next.top - top - height) : 0 }
}

// The person's prompts either side of `id`, for the steps: null at the first and the latest.
export const neighbours = (
  rows: readonly TurnStart[],
  id: string,
): { readonly before: string | null; readonly after: string | null } => {
  const mine = rows.filter((row) => row.mine)
  const at = mine.findIndex((row) => row.id === id)
  return { before: mine[at - 1]?.id ?? null, after: mine[at + 1]?.id ?? null }
}

// A prompt as one line: its breaks are spaces. Its images already stand as their `[Image #N]`
// placeholders.
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

// The words as a sentence for a label that goes on after them: a full stop added only where they
// don't already end one.
export const sentence = (words: string): string => (/[.!?…]$/.test(words) ? words : `${words}.`)

// How tall the held line stands (`.chat-hold-column`'s padding and a row), which the next turn's
// start has to clear to push it out: the row's line and its padding either side, in either size.
export const holdHeight = (compact: boolean): number => (compact ? 18 + 12 : 21 + 16)

// Where each start stands in the log's content, read from the rows the transcript marks with
// `data-turn`.
export const startRows = (
  scroller: HTMLElement,
  starts: readonly TurnStart[],
): readonly StartRow[] => {
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop
  const byId = new Map(starts.map((start) => [start.id, start]))
  return [...scroller.querySelectorAll<HTMLElement>("[data-turn]")].flatMap((node) => {
    const start = byId.get(node.dataset.turn ?? "")
    if (!start) return []
    const rect = node.getBoundingClientRect()
    return [{ ...start, top: rect.top - base, bottom: rect.bottom - base }]
  })
}

// Where the log scrolls to for a prompt: to the row itself, or just past it, so that the prompt
// now holds the top and its steps stay under the pointer.
export const scrollFor = (row: StartRow, to: "row" | "past"): number =>
  Math.max(0, to === "row" ? row.top : row.bottom)
