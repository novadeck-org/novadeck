import { describe, expect, it } from "../test.js"
import {
  arrivals,
  emptyEnterRefusal,
  enterAfter,
  escaper,
  excerpt,
  occurrences,
  stated,
  withScreen,
} from "./deck.js"

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

describe("withScreen", () => {
  it("follows a failed wait's message with the screen's non-blank rows", async () => {
    const error = await withScreen(
      new Error("t1 can't reach ready"),
      async () => "\n  Trust this folder?\n\n❯ 1. No, exit   \n\n",
    )

    expect(error.message).toBe(
      "t1 can't reach ready. Its screen:\n  Trust this folder?\n❯ 1. No, exit   ",
    )
  })

  it("says what its agent is doing before the screen, when asked", async () => {
    const error = await withScreen(
      new Error("Timed out"),
      async () => "❯ Try again",
      () => "idle, no request waiting",
    )

    expect(error.message).toBe(
      "Timed out. Its agent: idle, no request waiting. Its screen:\n❯ Try again",
    )
  })

  it("says why when the screen can't be read", async () => {
    const error = await withScreen(new Error("Timed out"), async () => {
      throw new Error("TERMINAL_NOT_FOUND")
    })

    expect(error.message).toBe("Timed out. Its screen:\n(can't be read: TERMINAL_NOT_FOUND)")
  })
})

describe("stated", () => {
  const activity = {
    state: "working" as const,
    attention: { pending: 1, kind: "permission" as const },
    planning: false,
    subagents: [],
    background: null,
    lastTurn: null,
  }

  it("says what the agent does and what waits on the person", () => {
    expect(stated(activity)).toBe("working, 1 request waiting (permission)")
    expect(stated({ ...activity, state: "idle", attention: { pending: 0, kind: null } })).toBe(
      "idle, no request waiting",
    )
  })

  it("says when there is no agent", () => {
    expect(stated(null)).toBe("no agent")
  })
})

describe("excerpt", () => {
  it("keeps the last rows of a long screen, saying how many it left out", () => {
    const shown = Array.from({ length: 5 }, (_, row) => `row ${row}`).join("\n")

    expect(excerpt(shown, 2)).toBe("(3 more rows above)\nrow 3\nrow 4")
  })

  it("calls a screen with nothing on it blank", () => {
    expect(excerpt("\n   \n")).toBe("(blank)")
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

describe("escaper", () => {
  it("keeps presses apart by the window, even when neither was awaited", async () => {
    const sent: { keys: string; at: number }[] = []
    const escape = escaper((keys) => sent.push({ keys, at: performance.now() }), 100)

    const first = escape()
    const second = escape("\x1b\x1b")
    expect(sent.map((one) => one.keys)).toEqual([])
    await first
    expect(sent.map((one) => one.keys)).toEqual(["\x1b"])
    await second

    expect(sent.map((one) => one.keys)).toEqual(["\x1b", "\x1b\x1b"])
    expect(sent[1]!.at - sent[0]!.at).toBeGreaterThanOrEqual(95)
  })

  it("refuses Enter, sending nothing", async () => {
    const sent: string[] = []
    const escape = escaper((keys) => sent.push(keys), 10)

    expect(() => escape("\x1b\r")).toThrow(/submit or confirm/)
    await escape()
    expect(sent).toEqual(["\x1b"])
  })
})

// A history of these delivery states.
const states = (...delivery: string[]) => delivery.map((one) => ({ delivery: one as "working" }))

describe("emptyEnterRefusal", () => {
  it("lets Enter through while the prompt's turn has worked since it started", () => {
    expect(emptyEnterRefusal(2, states("ready", "drafting", "drafting", "working"))).toBeUndefined()
  })

  it("refuses before any prompt, or once anything else was sent since", () => {
    expect(emptyEnterRefusal(undefined, states("working"))).toMatch(/submit a prompt/)
  })

  it("refuses before the turn works, and once it has stopped working", () => {
    expect(emptyEnterRefusal(1, states("ready", "drafting"))).toMatch(/is working/)
    expect(emptyEnterRefusal(1, states("ready", "working", "settled"))).toMatch(/is working/)
    expect(emptyEnterRefusal(1, states("ready", "working", "unknown", "working"))).toMatch(
      /is working/,
    )
  })
})
