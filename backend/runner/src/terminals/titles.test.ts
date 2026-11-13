import { terminalTitle } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import {
  cleanSummary,
  defaultTitle,
  described,
  murmured,
  openedWith,
  renamed,
  summaryChars,
  summaryRefusal,
  titleOf,
  titleRefusal,
  titledByHand,
  unnamed,
  type Naming,
} from "./titles.js"

const terminal = { handle: "fox", command: null }
const alone = terminal
const opener = { title: "Login fix", by: "moth" }
const murmur = { title: "Fixing login" }
const own = { title: "Login cookie" }

describe("a terminal's title", () => {
  it("is the person's, then the opening agent's, then murmur's, then its own agent's, then the default", () => {
    const named: Naming = { person: "Mine", opener, murmur, own, summary: "Fixes login." }
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
    // The terminal's own agent names it by its own handle, only where nothing above has.
    expect(titleOf({ ...named, person: null, opener: null, murmur: null }, terminal)).toEqual({
      title: "Login cookie",
      source: { kind: "agent", by: "fox" },
    })
    expect(titleOf(unnamed, terminal)).toEqual({
      title: "Terminal",
      source: { kind: "default" },
    })
  })

  it("ignores an opener's title that has no opener's handle to say who it is from", () => {
    const named: Naming = { ...unnamed, opener: { title: "Login fix" } }
    expect(titleOf(named, alone).source).toEqual({ kind: "default" })
    expect(titleOf({ ...named, murmur }, alone).source).toEqual({
      kind: "murmur",
    })
  })

  it("is kept from murmur when the person or the agent that opened the terminal gave it", () => {
    expect(titledByHand(unnamed)).toBe(false)
    expect(titledByHand({ ...unnamed, person: "Mine" })).toBe(true)
    expect(titledByHand({ ...unnamed, opener })).toBe(true)
    expect(titledByHand({ ...unnamed, opener: { title: "Login fix" } })).toBe(false)
    // An agent that asked for no title leaves murmur free to title it, as before.
    expect(titledByHand({ ...unnamed, opener: { by: "moth" } })).toBe(false)
    expect(titleOf({ ...unnamed, opener: { by: "moth" } }, terminal).source).toEqual({
      kind: "default",
    })
  })

  it("is its own agent's where nothing else named it, never made by a summary", () => {
    expect(titleOf(described(unnamed, "Login cookie", "Fixes login."), terminal)).toEqual({
      title: "Login cookie",
      source: { kind: "agent", by: "fox" },
    })
    expect(titleOf({ ...unnamed, summary: "Fixes login." }, terminal).source).toEqual({
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
    expect(titleOf(unnamed, { handle: "fox", command: "claude" }).title).toBe("claude")
  })

  // A title kept before the rule took in bidirectional marks and C1 controls would fail every
  // summary it is in, and with it the terminals' stream.
  it("is a kept title as a title may be now", () => {
    const title = terminalTitle
    const kept = { ...unnamed, person: "build\u202eevil\u009b" }
    expect(titleOf(kept, terminal)).toEqual({ title: "build evil", source: { kind: "person" } })
    expect(title.safeParse(titleOf(kept, terminal).title).success).toBe(true)
    const opened = { ...unnamed, opener: { title: "\u2066Server\u2069", by: "moth" } }
    expect(titleOf(opened, terminal).title).toBe("Server")
    // One with nothing left gives way to the next.
    expect(titleOf({ ...kept, person: "\u202e", murmur }, terminal)).toEqual({
      title: "Fixing login",
      source: { kind: "murmur" },
    })
    expect(title.safeParse(defaultTitle("ec\u202eho hi")).success).toBe(true)
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
    expect(openedWith(unnamed, "Server", "moth")).toEqual({
      ...unnamed,
      opener: { title: "Server", by: "moth" },
    })
    const opened = openedWith(murmured(unnamed, "Fixing login"), "Server", "moth")
    expect(titleOf(opened, terminal).title).toBe("Server")
    expect(openedWith(renamed(unnamed, "Mine"), "Server", "moth").person).toBe("Mine")
  })

  it("keeps the opener's handle for an agent that asked for no title", () => {
    expect(openedWith(unnamed, undefined, "moth").opener).toEqual({ by: "moth" })
  })

  it("keeps the opening agent's title as it is while murmur titles, and replaces murmur's each time", () => {
    const first = murmured(openedWith(unnamed, "Server", "moth"), "Fixing login")
    expect(first.opener).toEqual({ title: "Server", by: "moth" })
    const next = murmured(first, "Fixing signup")
    expect(next.murmur).toEqual({ title: "Fixing signup" })
    expect(next.opener).toEqual(first.opener)
  })

  it("keeps the agent's summary apart from every title, and replaces it each time", () => {
    const named = described(murmured(unnamed, "Fixing login"), "Login bug", "Fixes the login bug.")
    expect(named.summary).toBe("Fixes the login bug.")
    expect(named.murmur).toEqual(murmur)
    expect(named.own).toEqual({ title: "Login bug" })
    expect(described(named, "Signup", "Now the signup.")).toMatchObject({
      own: { title: "Signup" },
      summary: "Now the signup.",
    })
    // Murmur's next title leaves the agent's summary as it is.
    expect(murmured(named, "Fixing signup").summary).toBe("Fixes the login bug.")
  })
})

describe("an agent's title", () => {
  it("is one short line with words in it", () => {
    expect(titleRefusal("Checkout rounding fix")).toBeUndefined()
    expect(titleRefusal("")).toMatch(/empty/)
    expect(titleRefusal("---")).toMatch(/needs words/)
    expect(titleRefusal("x".repeat(81))).toMatch(/81 characters/)
    // Over the person's limit too, it is too long, not malformed.
    expect(titleRefusal("x".repeat(250))).toMatch(/250 characters/)
  })

  it("refuses what a person's title would: more than one line, control and direction marks", () => {
    for (const title of ["Two\nlines", "Tab\there", "Esc\u001b[2J", "C1\u009bnext", "Flip\u202eit"])
      expect(titleRefusal(title)).toMatch(/one line/)
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
