import { describe, expect, it } from "../test.js"
import {
  cleanSummary,
  defaultTitle,
  murmured,
  openedWith,
  renamed,
  summarized,
  summaryChars,
  summaryRefusal,
  titleOf,
  unnamed,
  type Naming,
} from "./naming.js"

const terminal = { handle: "t3" }
const agent = { title: "Login fix", by: "t1" }
const murmur = { title: "Fixing login" }

describe("a terminal's title", () => {
  it("is the person's, then murmur's, then the opening agent's, then the default", () => {
    const named: Naming = { person: "Mine", agent, murmur, summary: "Fixes login." }
    expect(titleOf(named, terminal)).toEqual({ title: "Mine", source: { kind: "person" } })
    expect(titleOf({ ...named, person: null }, terminal)).toEqual({
      title: "Fixing login",
      source: { kind: "murmur" },
    })
    expect(titleOf({ ...named, person: null, murmur: null }, terminal)).toEqual({
      title: "Login fix",
      source: { kind: "agent", by: "t1" },
    })
    expect(titleOf(unnamed, terminal)).toEqual({
      title: "Terminal 03",
      source: { kind: "default" },
    })
  })

  it("is never made by a summary", () => {
    expect(titleOf(summarized(unnamed, "Fixes login."), terminal).source).toEqual({
      kind: "default",
    })
  })

  it("is the session's default by its handle's number", () => {
    expect(defaultTitle("t3")).toBe("Terminal 03")
    expect(defaultTitle("t104")).toBe("Terminal 104")
    expect(titleOf(unnamed, { handle: "t12" }).title).toBe("Terminal 12")
  })
})

describe("naming a terminal", () => {
  it("gives the person's title, or takes it away so the title is automatic again", () => {
    const theirs = renamed({ ...unnamed, agent, murmur }, "Mine")
    expect(titleOf(theirs, terminal).title).toBe("Mine")
    // The other layers stay beneath theirs.
    expect(titleOf(renamed(theirs, null), terminal).source).toEqual({ kind: "murmur" })
    expect(renamed(theirs, null).agent).toEqual(agent)
  })

  it("takes the title an opener asked for as that agent's, beneath murmur's and the person's", () => {
    expect(openedWith(unnamed, "Server", "t1")).toEqual({
      ...unnamed,
      agent: { title: "Server", by: "t1" },
    })
    const opened = openedWith(murmured(unnamed, "Fixing login"), "Server", "t1")
    expect(titleOf(opened, terminal).title).toBe("Fixing login")
    expect(openedWith(renamed(unnamed, "Mine"), "Server", "t1").person).toBe("Mine")
  })

  it("keeps the opening agent's title as it is while murmur titles, and replaces murmur's each time", () => {
    const first = murmured(openedWith(unnamed, "Server", "t1"), "Fixing login")
    expect(first.agent).toEqual({ title: "Server", by: "t1" })
    const next = murmured(first, "Fixing signup")
    expect(next.murmur).toEqual({ title: "Fixing signup" })
    expect(next.agent).toEqual(first.agent)
  })

  it("keeps the agent's summary apart from every title, and replaces it each time", () => {
    const named = summarized(murmured(unnamed, "Fixing login"), "Fixes the login bug.")
    expect(named.summary).toBe("Fixes the login bug.")
    expect(named.murmur).toEqual(murmur)
    expect(summarized(named, "Now the signup.").summary).toBe("Now the signup.")
    // Murmur's next title leaves the agent's summary as it is.
    expect(murmured(named, "Fixing signup").summary).toBe("Fixes the login bug.")
  })
})

describe("a summary", () => {
  it("keeps its lines, each on one line of its own", () => {
    expect(cleanSummary("  Fixes  the\tbug. \n\n Then tests.\r\n")).toBe(
      "Fixes the bug.\nThen tests.",
    )
    expect(cleanSummary("a\u0000b‮c")).toBe("a b‮c")
  })

  it("takes one or two lines of up to 200 characters, with words in them", () => {
    expect(summaryRefusal("Fixes the login bug.\nThen its tests.")).toBeUndefined()
    expect(summaryRefusal("é".repeat(summaryChars))).toBeUndefined()
    expect(summaryRefusal("")).toMatch(/^The summary is empty/)
    expect(summaryRefusal("***")).toMatch(/needs words/)
    expect(summaryRefusal("a".repeat(summaryChars + 1))).toMatch(/201 characters over 1 lines/)
    expect(summaryRefusal("a\nb\nc")).toMatch(/3 lines/)
  })
})
