import type { HarnessEvent } from "@novadeck/harness-core/events"

import type { Root } from "../harnesses/roots.js"
import { describe, expect, it } from "../test.js"
import {
  busiestFolders,
  currentCheckout,
  firstFrom,
  freshWork,
  judgedFirst,
  keptFiles,
  keptFolders,
  lastFiles,
  keptPlaces,
  personPrompted,
  plainPrompt,
  promptChars,
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

const ran = (folder: string, actor: string | null = null): HarnessEvent => ({
  type: "tool-called",
  ...fact,
  actor,
  toolName: "Bash",
  kind: "work",
  folder,
})

describe("where a root session works now", () => {
  it("keeps the folders of its latest commands and writes, the latest first", () => {
    const work = workAfter(
      null,
      root,
      [ran("/t/a"), touched("/t/b/src/x.ts"), prompted("go"), ran("/t/b")],
      1,
    )
    expect(work?.places).toEqual(["/t/b", "/t/b/src", "/t/a"])
  })

  it("counts a subagent's writes but not its commands, nor a call naming no folder", () => {
    const work = workAfter(
      null,
      root,
      [
        ran("/elsewhere", "a1"),
        { type: "file-touched", ...fact, actor: "a1", path: "/t/b/x.ts" },
        { type: "tool-called", ...fact, actor: null, toolName: "Read", kind: "work" },
      ],
      1,
    )
    expect(work?.places).toEqual(["/t/b"])
  })

  it("keeps the latest few, and is the same work while the calls stay in one folder", () => {
    const calls = Array.from({ length: keptPlaces + 3 }, () => ran("/t/a"))
    const work = workAfter(null, root, [ran("/t/z"), ...calls], 1)
    expect(work?.places).toEqual(Array.from({ length: keptPlaces }, () => "/t/a"))
    expect(workAfter(work, root, [ran("/t/a")], 2)).toBe(work)
  })

  it("is the checkout most of its latest places are in, the latest on a tie", () => {
    const checkout = (folder: string) =>
      folder.startsWith("/tmp") ? null : `/${folder.split("/")[1]}`
    // One look into another checkout doesn't move it.
    expect(currentCheckout(["/s/x", "/b/1", "/b/2", "/b/3"], checkout)).toBe("/b")
    expect(currentCheckout(["/a/x", "/b/y"], checkout)).toBe("/a")
    // A scratchpad, outside every checkout, never counts.
    expect(currentCheckout(["/tmp/1", "/tmp/2", "/b/x"], checkout)).toBe("/b")
    expect(currentCheckout(["/tmp/1"], checkout)).toBeNull()
    expect(currentCheckout([], checkout)).toBeNull()
  })
})

describe("a prompt as others read it", () => {
  it("drops the tags wrapping one agent's message to another, naming its sender", () => {
    expect(
      plainPrompt(
        '<agent-message from="sable" id="m1">\n[Subagent hand-back] Done.\n</agent-message>',
      ),
    ).toBe("(a message from sable) [Subagent hand-back] Done.")
    expect(
      plainPrompt(
        '<novadeck-messages note="…"><message id="m" from="fox" thread="t">Fix it</message></novadeck-messages>',
      ),
    ).toBe("(a message from fox) Fix it")
  })

  it("leaves a prompt with no such tags as it is, other markup too", () => {
    expect(plainPrompt("Fix <b>bold</b> in a <div>")).toBe("Fix <b>bold</b> in a <div>")
  })

  it("is what the work keeps of the person's prompt", () => {
    const work = workAfter(
      null,
      root,
      [prompted('<agent-message from="sable">Go</agent-message>')],
      1,
    )
    expect(work?.first).toBe("(a message from sable) Go")
  })
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

  it("keeps when the person's latest prompt started its turn, never moving it back", () => {
    const work = freshWork("codex:s1")
    expect(personPrompted(work, 10).personAt).toBe(10)
    expect(personPrompted(personPrompted(work, 10), 5).personAt).toBe(10)
    expect(personPrompted(personPrompted(work, 10), 20).personAt).toBe(20)
  })

  it("tallies the folders it writes in, and when it was last active", () => {
    const work = workAfter(null, root, [touched("/w/src/a.ts"), touched("/w/src/b.ts")], 9)
    expect(work).toMatchObject({
      folders: { "/w/src": 2 },
      files: ["/w/src/b.ts", "/w/src/a.ts"],
      activeAt: 9,
    })
  })

  it("keeps the paths of the files written in last, each once, the latest first", () => {
    let files: readonly string[] | undefined
    for (let index = 0; index < 30; index += 1) files = lastFiles(files, `f${index}.ts`)
    expect(files).toHaveLength(keptFiles)
    expect(files![0]).toBe("f29.ts")
    expect(lastFiles(files, "f25.ts")).toEqual([
      "f25.ts",
      ...files!.filter((name) => name !== "f25.ts"),
    ])
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
      files: ["/w/a.ts"],
      places: ["/w"],
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
    expect(firstFrom(null, "moth")).toBeNull()
  })

  it("is the opener's in an agent-opened terminal's first session, unless the person submitted it", () => {
    expect(firstFrom(first({ opened: true, firstByPerson: false }), "moth")).toBe("opener")
    // Not told yet: the opener's, until told otherwise.
    expect(firstFrom(first({ opened: true }), "moth")).toBe("opener")
    expect(firstFrom(first({ opened: true, firstByPerson: true }), "moth")).toBe("user")
    // A later session there is the person's.
    expect(firstFrom(first({ firstByPerson: false }), "moth")).toBe("user")
  })

  it("is told once, and only of a first prompt", () => {
    expect(judgedFirst(first(), true).firstByPerson).toBe(true)
    expect(judgedFirst(first({ firstByPerson: false }), true).firstByPerson).toBe(false)
    expect(judgedFirst(freshWork("claude:s1"), true)).toEqual(freshWork("claude:s1"))
  })
})
