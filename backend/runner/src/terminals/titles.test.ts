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
  titledByHand,
  unnamed,
  type Naming,
} from "./titles.js"

const terminal = { command: null, openedBy: "moth" }
const opener = { title: "Login fix" }
const murmur = { title: "Fixing login" }

describe("a terminal's title", () => {
  it("is the person's, then the opening agent's, then murmur's, then the default", () => {
    const named: Naming = { person: "Mine", opener, murmur, summary: "Fixes login." }
    expect(titleOf(named, terminal)).toEqual({ title: "Mine", source: { kind: "person" } })
    // A lead's title outlasts a local model's later one.
    expect(titleOf({ ...named, person: null }, terminal)).toEqual({
      title: "Login fix",
      source: { kind: "agent", by: "moth" },
    })
    expect(titleOf({ ...named, person: null, opener: null }, terminal)).toEqual({
      title: "Fixing login",
      source: { kind: "murmur" },
    })
    expect(titleOf(unnamed, terminal)).toEqual({
      title: "Terminal",
      source: { kind: "default" },
    })
  })

  it("ignores an opener's title when no terminal opened it", () => {
    const named: Naming = { ...unnamed, opener }
    expect(titleOf(named, { command: null, openedBy: null }).source).toEqual({ kind: "default" })
    expect(titleOf({ ...named, murmur }, { command: null, openedBy: null }).source).toEqual({
      kind: "murmur",
    })
  })

  it("is kept from murmur when the person or the agent that opened the terminal gave it", () => {
    expect(titledByHand(unnamed, "moth")).toBe(false)
    expect(titledByHand({ ...unnamed, person: "Mine" }, null)).toBe(true)
    expect(titledByHand({ ...unnamed, opener }, "moth")).toBe(true)
    expect(titledByHand({ ...unnamed, opener }, null)).toBe(false)
  })

  it("is never made by a summary", () => {
    expect(titleOf(summarized(unnamed, "Fixes login."), terminal).source).toEqual({
      kind: "default",
    })
  })

  it("is by default the program the terminal was opened to run, else Terminal", () => {
    expect(defaultTitle("claude")).toBe("claude")
    expect(defaultTitle("claude --resume abc")).toBe("claude")
    expect(defaultTitle("/usr/local/bin/codex 'fix it'")).toBe("codex")
    expect(defaultTitle("pnpm dev")).toBe("pnpm")
    expect(defaultTitle("")).toBe("Terminal")
    expect(defaultTitle("   ")).toBe("Terminal")
    expect(defaultTitle("' ' ls")).toBe("Terminal")
    expect(defaultTitle(`'${"x".repeat(201)}' --flag`)).toBe("Terminal")
    expect(defaultTitle("cd app && pnpm dev")).toBe("pnpm")
    expect(defaultTitle("cd a; cd b && claude")).toBe("claude")
    expect(defaultTitle("cd app")).toBe("cd")
    expect(defaultTitle("API_KEY=sk-123 npm run dev")).toBe("npm")
    expect(defaultTitle("env A=1 B=2 /usr/bin/codex")).toBe("codex")
    expect(defaultTitle("A=1")).toBe("Terminal")
    expect(defaultTitle(null)).toBe("Terminal")
    expect(titleOf(unnamed, { command: "claude", openedBy: null }).title).toBe("claude")
  })
})

describe("naming a terminal", () => {
  it("gives the person's title, or takes it away so the title is automatic again", () => {
    const theirs = renamed({ ...unnamed, opener, murmur }, "Mine")
    expect(titleOf(theirs, terminal).title).toBe("Mine")
    // The other layers stay beneath theirs.
    expect(titleOf(renamed(theirs, null), terminal).source).toEqual({ kind: "agent", by: "moth" })
    expect(renamed(theirs, null).opener).toEqual(opener)
  })

  it("takes the title an opener asked for as that agent's, over murmur's and beneath the person's", () => {
    expect(openedWith(unnamed, "Server")).toEqual({
      ...unnamed,
      opener: { title: "Server" },
    })
    const opened = openedWith(murmured(unnamed, "Fixing login"), "Server")
    expect(titleOf(opened, terminal).title).toBe("Server")
    expect(openedWith(renamed(unnamed, "Mine"), "Server").person).toBe("Mine")
  })

  it("keeps the opening agent's title as it is while murmur titles, and replaces murmur's each time", () => {
    const first = murmured(openedWith(unnamed, "Server"), "Fixing login")
    expect(first.opener).toEqual({ title: "Server" })
    const next = murmured(first, "Fixing signup")
    expect(next.murmur).toEqual({ title: "Fixing signup" })
    expect(next.opener).toEqual(first.opener)
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
