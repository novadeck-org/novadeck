// How a request's numbered menu takes its keys, as a terminal's does: 1–9 go to that row and
// press it, ↑↓ move round and round, Home and End go to its ends, Enter (and Space, in a menu of
// one choice) presses the row the cursor is on. In a menu of several picks a press ticks the
// row, and Enter sends, but on a row that leaves the menu, as the way to the terminal, which it
// presses. Where an answer is hard to take back the first press only arms it; pressing it again
// sends, and moving away disarms it. Pure, so the menu's rules read apart from its markup.

export type Cursor = { readonly at: number; readonly armed: number | null }

export const startCursor: Cursor = { at: 0, armed: null }

export type MenuShape = {
  readonly count: number
  // Several picks: a press ticks, Enter sends.
  readonly multi: boolean
  // Whether a press of this row must be armed first.
  readonly arms: (at: number) => boolean
  // Whether a row leaves the menu rather than answering, as the way to the terminal.
  readonly leaves: (at: number) => boolean
}

// What a key did: where the cursor is now, and the row pressed ("send" for Enter in a
// menu of several picks); null for a key that isn't the menu's.
export type KeyResult = { readonly cursor: Cursor; readonly press: number | "send" | null }

const press = (shape: MenuShape, cursor: Cursor, at: number): KeyResult => {
  if (!shape.multi && shape.arms(at) && cursor.armed !== at)
    return { cursor: { at, armed: at }, press: null }
  return { cursor: { at, armed: null }, press: at }
}

const move = (at: number): KeyResult => ({ cursor: { at, armed: null }, press: null })

export const menuKey = (shape: MenuShape, cursor: Cursor, key: string): KeyResult | null => {
  const { count } = shape
  if (count === 0) return null
  if (/^[1-9]$/.test(key)) {
    const at = Number(key) - 1
    return at >= count ? null : press(shape, cursor, at)
  }
  switch (key) {
    case "ArrowDown":
      return move((cursor.at + 1) % count)
    case "ArrowUp":
      return move((cursor.at + count - 1) % count)
    case "Home":
      return move(0)
    case "End":
      return move(count - 1)
    case "Enter":
      return shape.multi && !shape.leaves(cursor.at)
        ? { cursor: { ...cursor, armed: null }, press: "send" }
        : press(shape, cursor, cursor.at)
    case " ":
      return press(shape, cursor, cursor.at)
    default:
      return null
  }
}

// Whether a key answers (or ticks): a number, Enter or Space. A held one repeats, and a
// repeat must never answer, nor send what its first press armed.
export const answering = (key: string): boolean =>
  /^[1-9]$/.test(key) || key === "Enter" || key === " "
