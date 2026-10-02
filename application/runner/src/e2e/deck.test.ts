import { describe, expect, it } from "../test.js"
import { arrivals, enterAfter, occurrences } from "./deck.js"

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

describe("arrivals", () => {
  it("gives each value once, in the order they came, whether taken before or after", async () => {
    const opened = arrivals<string>("a terminal")
    opened.push("t2")
    const later = opened.next()
    const latest = opened.next()
    opened.push("t3")
    opened.push("t4")

    await expect(later).resolves.toBe("t2")
    await expect(latest).resolves.toBe("t3")
    await expect(opened.next()).resolves.toBe("t4")
  })

  it("fails the taker of a failure, and the next taker still gets the value after it", async () => {
    const opened = arrivals<string>("a terminal")
    opened.fail(new Error("It couldn't open"))
    opened.push("t3")

    await expect(opened.next()).rejects.toThrow("It couldn't open")
    await expect(opened.next()).resolves.toBe("t3")
  })

  it("times out saying what it waited for, and leaves the value that comes later for the next", async () => {
    const opened = arrivals<string>("a terminal")

    await expect(opened.next(50)).rejects.toThrow("waiting for a terminal")
    opened.push("t2")
    await expect(opened.next(50)).resolves.toBe("t2")
  })
})
