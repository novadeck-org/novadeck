import type { HarnessEvent } from "../harnesses/events.js"
import type { Root } from "../harnesses/roots.js"
import { describe, expect, it } from "../test.js"
import {
  busiestFolders,
  firstFrom,
  freshWork,
  judgedFirst,
  keptFolders,
  promptChars,
  shorten,
  tallied,
  workAfter,
  type Work,
} from "./work.js"

const root: Root = { agent: "codex", sessionId: "s1", instance: "2", source: "binding" }
const fact = { agent: "codex", sessionId: "s1", instance: "2", startedAt: 1 } as const

const prompted = (prompt: string, cause: "prompt" | "harness" = "prompt"): HarnessEvent => ({
  type: "turn-started",
  ...fact,
  cause,
  prompt,
})

const touched = (path: string): HarnessEvent => ({
  type: "file-touched",
  ...fact,
  actor: null,
  path,
})

describe("what a root session worked on", () => {
  it("is the person's first and latest prompts, shortened, never a turn the harness started", () => {
    let work = workAfter(null, root, [prompted(`Build the users API ${"and more ".repeat(20)}`)], 5)
    expect(work).toMatchObject({ session: "codex:s1", activeAt: 5 })
    expect(work!.first).toMatch(/^Build the users API and more .*…$/)
    expect(work!.first!.length).toBeLessThanOrEqual(promptChars)
    work = workAfter(work, root, [prompted("<task-notification>done", "harness")], 6)
    expect(work).toMatchObject({ latest: work!.first, activeAt: 6 })
    work = workAfter(work, root, [prompted("Now add paging")], 7)
    expect(work).toMatchObject({ latest: "Now add paging" })
    expect(work!.first).toMatch(/^Build/)
  })

  it("tallies the folders it writes in, and when it was last active", () => {
    const work = workAfter(null, root, [touched("/w/src/a.ts"), touched("/w/src/b.ts")], 9)
    expect(work).toMatchObject({ folders: { "/w/src": 2 }, activeAt: 9 })
  })

  it("starts afresh for another session, keeps its own, and is kept without a root", () => {
    const work = workAfter(null, root, [prompted("Build it")], 1)
    expect(workAfter(work, root, [], 2)).toBe(work)
    expect(workAfter(work, null, [], 2)).toBe(work)
    expect(workAfter(work, { ...root, sessionId: "s2" }, [], 2)).toEqual({
      session: "codex:s2",
      first: null,
      latest: null,
      folders: {},
      activeAt: null,
    })
    // Another session's facts, as a subagent's, are not its own.
    const other: HarnessEvent = { ...touched("/w/x.ts"), sessionId: "s9" }
    expect(workAfter(work, root, [other], 3)).toEqual(work)
  })

  it("carries over to the session a guess at the root was corrected to", () => {
    const guess: Root = { ...root, agent: "agy", sessionId: "c-sub", source: "binding" }
    const agy = { ...fact, agent: "agy", sessionId: "c-sub" } as const
    const work = workAfter(
      null,
      guess,
      [{ type: "file-touched", ...agy, actor: null, path: "/w/a.ts" }],
      4,
    )
    const corrected: Root = { ...guess, sessionId: "c-root", source: "status-line" }
    const change = { type: "corrected", from: "c-sub", root: corrected, confirmed: true } as const
    expect(workAfter(work, corrected, [], 5, [change])).toEqual({
      session: "agy:c-root",
      first: null,
      latest: null,
      folders: { "/w": 1 },
      activeAt: 4,
    })
    // Without the correction, another session starts afresh.
    expect(workAfter(work, corrected, [], 5)).toMatchObject({ folders: {}, activeAt: null })
  })

  it("keeps the folders written in most, and always the one just written in", () => {
    let folders: Record<string, number> = {}
    for (let index = 0; index < 30; index += 1)
      for (let edit = 0; edit <= index; edit += 1) folders = { ...tallied(folders, `/f${index}`) }
    expect(Object.keys(folders)).toHaveLength(keptFolders)
    expect(folders["/f29"]).toBe(30)
    expect(folders["/f0"]).toBeUndefined()
    const fresh = tallied(folders, "/new")
    expect(fresh["/new"]).toBe(1)
    expect(Object.keys(fresh)).toHaveLength(keptFolders)
  })

  it("names the three folders written in most, ties by name", () => {
    expect(busiestFolders({ "/b": 2, "/a": 2, "/c": 5, "/d": 1 })).toEqual([
      { folder: "/c", edits: 5 },
      { folder: "/a", edits: 2 },
      { folder: "/b", edits: 2 },
    ])
  })

  it("shortens text to one line", () => {
    expect(shorten("add\n  pagination   to /users", 120)).toBe("add pagination to /users")
    expect(shorten("x".repeat(130), 120)).toBe(`${"x".repeat(119)}…`)
  })
})

// A root session's work with its first prompt.
const first = (fields: Partial<Work> = {}): Work => ({
  ...freshWork("claude:s1"),
  first: "fix the build",
  latest: "fix the build",
  ...fields,
})

describe("whose a root session's first prompt is", () => {
  it("is the user's in a terminal the person opened, however it came", () => {
    expect(firstFrom(first({ firstByPerson: false }), null)).toBe("user")
    expect(firstFrom(first(), null)).toBe("user")
    expect(firstFrom(freshWork("claude:s1"), null)).toBeNull()
    expect(firstFrom(null, "t1")).toBeNull()
  })

  it("is the opener's in an agent-opened terminal's first session, unless the person submitted it", () => {
    expect(firstFrom(first({ opened: true, firstByPerson: false }), "t1")).toBe("opener")
    // Not told yet: the opener's, until told otherwise.
    expect(firstFrom(first({ opened: true }), "t1")).toBe("opener")
    expect(firstFrom(first({ opened: true, firstByPerson: true }), "t1")).toBe("user")
    // A later session there is the person's.
    expect(firstFrom(first({ firstByPerson: false }), "t1")).toBe("user")
  })

  it("is told once, and only of a first prompt", () => {
    expect(judgedFirst(first(), true).firstByPerson).toBe(true)
    expect(judgedFirst(first({ firstByPerson: false }), true).firstByPerson).toBe(false)
    expect(judgedFirst(freshWork("claude:s1"), true)).toEqual(freshWork("claude:s1"))
  })
})
