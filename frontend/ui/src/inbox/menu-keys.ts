// How a sheet's numbered menu takes its keys: 1–n go to that row and press it, ↑↓ move,
// Home and End go to its ends, Enter (and Space, in a menu of one choice) presses the row
// the cursor is on. In a menu of several picks a press ticks the row, and Enter sends.
// Where an answer is hard to take back the first press only arms it; pressing it again
// sends, and moving away disarms it. Pure, so the menu's rules read apart from its markup.

export type Cursor = { readonly at: number; readonly armed: number | null }

export const startCursor: Cursor = { at: 0, armed: null }

export type MenuShape = {
  readonly count: number
  // Several picks: a press ticks, Enter sends.
  readonly multi: boolean
  // Whether a press of this row must be armed first.
  readonly arms: (at: number) => boolean
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
  if (shape.count === 0) return null
  const last = shape.count - 1
  if (/^[1-9]$/.test(key)) {
    const at = Number(key) - 1
    return at > last ? null : press(shape, cursor, at)
  }
  switch (key) {
    case "ArrowDown":
      return move(Math.min(last, cursor.at + 1))
    case "ArrowUp":
      return move(Math.max(0, cursor.at - 1))
    case "Home":
      return move(0)
    case "End":
      return move(last)
    case "Enter":
      return shape.multi
        ? { cursor: { ...cursor, armed: null }, press: "send" }
        : press(shape, cursor, cursor.at)
    case " ":
      return press(shape, cursor, cursor.at)
    default:
      return null
  }
}
