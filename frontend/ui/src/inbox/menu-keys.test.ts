import { context, describe, expect, it } from "../test"
import { answering, menuKey, startCursor, type MenuShape } from "./menu-keys"

const one: MenuShape = { count: 3, multi: false, arms: () => false, leaves: () => false }
const several: MenuShape = { count: 3, multi: true, arms: () => false, leaves: (at) => at === 2 }
const hard: MenuShape = { count: 2, multi: false, arms: () => true, leaves: () => false }

describe("A sheet's menu keys", () => {
  context("in a menu of one choice", () => {
    it("presses a row at once by its number", () => {
      expect(menuKey(one, startCursor, "2")).toEqual({ cursor: { at: 1, armed: null }, press: 1 })
    })

    it("ignores a number past its last row, and keys that aren't its own", () => {
      expect(menuKey(one, startCursor, "4")).toBeNull()
      expect(menuKey(one, startCursor, "a")).toBeNull()
    })

    it("moves with the arrows within its ends, and presses the cursor's row on Enter", () => {
      const down = menuKey(one, startCursor, "ArrowDown")!
      expect(down).toEqual({ cursor: { at: 1, armed: null }, press: null })
      expect(menuKey(one, { at: 2, armed: null }, "ArrowDown")!.cursor.at).toBe(2)
      expect(menuKey(one, startCursor, "ArrowUp")!.cursor.at).toBe(0)
      expect(menuKey(one, startCursor, "End")!.cursor.at).toBe(2)
      expect(menuKey(one, down.cursor, "Enter")!.press).toBe(1)
      expect(menuKey(one, down.cursor, " ")!.press).toBe(1)
    })
  })

  context("in a menu of several picks", () => {
    it("ticks a row by its number or Space, and sends on Enter", () => {
      expect(menuKey(several, startCursor, "3")!.press).toBe(2)
      expect(menuKey(several, { at: 1, armed: null }, " ")!.press).toBe(1)
      expect(menuKey(several, { at: 1, armed: null }, "Enter")!.press).toBe("send")
    })

    it("presses a row that leaves the menu on Enter, rather than sending", () => {
      expect(menuKey(several, { at: 2, armed: null }, "Enter")!.press).toBe(2)
    })
  })

  context("where an answer is hard to undo", () => {
    it("arms on the first press and sends on the second", () => {
      const first = menuKey(hard, startCursor, "1")!
      expect(first).toEqual({ cursor: { at: 0, armed: 0 }, press: null })
      expect(menuKey(hard, first.cursor, "1")!.press).toBe(0)
      expect(menuKey(hard, first.cursor, "Enter")!.press).toBe(0)
    })

    it("disarms when the cursor moves, or another row is pressed", () => {
      const first = menuKey(hard, startCursor, "1")!
      expect(menuKey(hard, first.cursor, "ArrowDown")!.cursor.armed).toBeNull()
      expect(menuKey(hard, first.cursor, "2")).toEqual({
        cursor: { at: 1, armed: 1 },
        press: null,
      })
    })
  })
})

describe("A key that answers", () => {
  it("is a number, Enter or Space, never an arrow", () => {
    expect(["1", "9", "Enter", " "].every(answering)).toBe(true)
    expect(["ArrowDown", "Home", "0", "a"].some(answering)).toBe(false)
  })
})
