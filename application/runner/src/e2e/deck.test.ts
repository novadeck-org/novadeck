import { describe, expect, it } from "../test.js"
import { enterAfter, occurrences } from "./deck.js"

describe("occurrences", () => {
  it("counts a text each time the screen shows it", () => {
    expect(occurrences("Allow? Yes\nAllow? Yes", "Allow?")).toBe(2)
    expect(occurrences("Nothing here", "Allow?")).toBe(0)
  })

  it("counts every match of a pattern, global or not", () => {
    expect(occurrences("Allow? Yes\nallow? No", /allow\?/i)).toBe(2)
    expect(occurrences("Allow? Yes\nAllow? No", /Allow\?/g)).toBe(2)
  })
})

// A screen a test draws on, and how often Enter was pressed on it.
const fake = (shown: string) => {
  const state = { shown, entered: 0 }
  const keys = {
    handle: "t1",
    screen: async () => state.shown,
    enter: () => {
      state.entered += 1
    },
  }
  return { state, keys }
}

describe("enterAfter", () => {
  it("presses Enter on a dialog drawn while its trigger ran, before the wait began", async () => {
    const { state, keys } = fake("Working…")

    await enterAfter(keys, "Allow this tool?", async () => {
      state.shown = "Allow this tool?\n> Yes"
    })

    expect(state.entered).toBe(1)
  })

  it("never lets text left from an earlier dialog through", async () => {
    const { state, keys } = fake("Allow this tool?\n> Yes")

    await expect(enterAfter(keys, "Allow this tool?", async () => {}, 300)).rejects.toThrow(
      /once more/,
    )
    expect(state.entered).toBe(0)
  })
})
