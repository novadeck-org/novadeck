import { describe, expect, it } from "../test.js"
import {
  atPrompt,
  backstopPrompts,
  afterSummary,
  drifted,
  artifactsNotice,
  fired,
  noNudges,
  noticesAt,
  nudgeText,
  personPrompted,
  take,
  type Facts,
  type Nudges,
} from "./nudges.js"
import { busiestFolders, tallied, type Work } from "./work.js"

const facts: Facts = { plan: "Pagination", folder: "/w/src/api", branch: "feat/paging" }

/** Whether the next quiet prompt nudges, and the nudges after it. */
const quietly = (nudges: Nudges) => take(nudges, true)

describe("nudges to describe a terminal", () => {
  it("add nothing while no trigger fired", () => {
    expect(quietly(noNudges)).toEqual({
      nudge: false,
      artifacts: false,
      summarize: false,
      nudges: noNudges,
    })
    expect(quietly(personPrompted(afterSummary(noNudges, facts)))).toMatchObject({ nudge: false })
  })

  it("nudge once for each trigger, then wait for the next", () => {
    for (const trigger of ["session", "compaction", "drift", "prompts"] as const) {
      const first = quietly(fired(noNudges, trigger))
      expect(first.nudge).toBe(true)
      // Ignored: nothing more until another trigger fires.
      expect(quietly(first.nudges).nudge).toBe(false)
      expect(quietly(fired(first.nudges, trigger)).nudge).toBe(true)
    }
    // Triggers that fire together nudge once.
    const both = quietly(fired(fired(noNudges, "session"), "compaction"))
    expect(both.nudge).toBe(true)
    expect(quietly(both.nudges).nudge).toBe(false)
  })

  it("never ride along with messages: the trigger waits for an answer that has nothing else", () => {
    const pending = fired(noNudges, "session")
    const busy = take(pending, false)
    expect(busy).toEqual({ nudge: false, artifacts: false, summarize: false, nudges: pending })
    expect(quietly(busy.nudges).nudge).toBe(true)
  })

  it("are cleared by a describe, which drift is then measured from", () => {
    const after = afterSummary(noNudges, facts)
    expect(after).toEqual({
      pending: [],
      prompts: 0,
      baseline: facts,
      driftedTo: null,
      artifacts: false,
    })
    expect(quietly(drifted(after, facts)).nudge).toBe(false)
  })

  it("nudge once when the plan, the main folder or the branch drifts from the last describe", () => {
    for (const change of [
      { plan: "Caching" },
      { folder: "/w/web" },
      { branch: "main" },
    ] satisfies Partial<Facts>[]) {
      const moved = { ...facts, ...change }
      const once = quietly(drifted(afterSummary(noNudges, facts), moved))
      expect(once.nudge).toBe(true)
      // The same drift never fires again; a further one does.
      expect(quietly(drifted(once.nudges, moved)).nudge).toBe(false)
      expect(quietly(drifted(once.nudges, { ...moved, branch: "other" })).nudge).toBe(true)
    }
    // Before any describe there is nothing to drift from.
    expect(quietly(drifted(noNudges, facts)).nudge).toBe(false)
  })

  it("nudge as a backstop after enough of the person's prompts since the last describe", () => {
    let nudges = afterSummary(noNudges, facts)
    for (let count = 1; count < backstopPrompts; count += 1) nudges = personPrompted(nudges)
    expect(quietly(nudges).nudge).toBe(false)
    nudges = personPrompted(nudges)
    const backstop = quietly(nudges)
    expect(backstop.nudge).toBe(true)
    // Ignored, it waits for as many prompts again.
    nudges = backstop.nudges
    for (let count = 1; count < backstopPrompts; count += 1) nudges = personPrompted(nudges)
    expect(quietly(nudges).nudge).toBe(false)
    expect(quietly(personPrompted(nudges)).nudge).toBe(true)
  })
})

describe("drift", () => {
  it("fires once when the work goes back and forth between two folders", () => {
    // The critic's probe: red/green, a test folder then the code, uneven counts.
    let folders: Work["folders"] = { "/r/src": 1 }
    let nudges = afterSummary(noNudges, { plan: null, folder: "/r/src", branch: "main" })
    let nudged = 0
    for (let prompt = 0; prompt < 20; prompt += 1) {
      const folder = prompt % 2 ? "/r/src" : "/r/test"
      folders = tallied(tallied(folders, folder), folder)
      const [main] = busiestFolders(folders, 1)
      const after = quietly(drifted(nudges, { plan: null, folder: main!.folder, branch: "main" }))
      nudges = after.nudges
      if (after.nudge) nudged += 1
    }
    expect(nudged).toBeLessThanOrEqual(1)
  })

  it("takes what isn't known, as a branch not read in time or no folder yet, for no change", () => {
    const after = afterSummary(noNudges, facts)
    for (const unknown of [{ plan: null }, { folder: null }, { branch: null }])
      expect(quietly(drifted(after, { ...facts, ...unknown })).nudge).toBe(false)
    // Nor is something known now a change from nothing known at the describe.
    expect(
      quietly(drifted(afterSummary(noNudges, { plan: null, folder: null, branch: null }), facts))
        .nudge,
    ).toBe(false)
  })
})

describe("a prompt's nudge", () => {
  it("counts the prompt, looks at drift, and nudges only an answer with nothing else", () => {
    const moved = { ...facts, branch: "main" }
    const busy = atPrompt(afterSummary(noNudges, facts), { quiet: false, facts: moved })
    expect(busy.nudge).toBe(false)
    expect(busy.nudges).toMatchObject({ prompts: 1, pending: ["drift"] })
    expect(atPrompt(busy.nudges, { quiet: true })).toMatchObject({
      nudge: true,
      nudges: { prompts: 2, pending: [] },
    })
  })
})

describe("a nudge", () => {
  it("asks for a summary while there is none, as one line of Novadeck's notice", () => {
    const text = nudgeText({ summary: null })
    expect(text).toMatch(/^Novadeck: automatic notice, not from the user: this terminal has no/)
    expect(text).toContain("summarize tool")
    expect(text).not.toContain("\n")
    expect(text).not.toContain("asked")
  })

  it("tells a session of the bar beside it when it begins or forgot, then only of the description", () => {
    const current = { summary: null }
    for (const trigger of ["session", "compaction"] as const) {
      const taken = quietly(fired(noNudges, trigger))
      expect(taken).toMatchObject({ nudge: true, artifacts: true, summarize: true })
      expect(noticesAt(taken, current).split("\n\n")).toEqual([artifactsNotice, nudgeText(current)])
      expect(quietly(taken.nudges).nudge).toBe(false)
    }
    for (const trigger of ["drift", "prompts"] as const) {
      const taken = quietly(fired(noNudges, trigger))
      expect(taken).toMatchObject({ artifacts: false, summarize: true })
      expect(noticesAt(taken, current)).toBe(nudgeText(current))
    }
    expect(artifactsNotice).toMatch(/^Novadeck: automatic notice, not from the user: /)
    expect(artifactsNotice).not.toContain("\n")
    for (const word of [
      "show tool",
      "deliverable",
      "not each file you touch",
      "diff",
      "open",
      "close",
    ])
      expect(artifactsNotice).toContain(word)
  })

  it("still tells of the bar after a describe came before the first quiet prompt", () => {
    const current = { summary: "Builds the API." }
    // The session's first prompt carried a message, then the agent afterSummary itself.
    const busy = take(fired(noNudges, "session"), false)
    const after = afterSummary(busy.nudges, facts)
    expect(after.pending).toEqual([])
    const taken = quietly(after)
    expect(taken).toMatchObject({ nudge: true, artifacts: true, summarize: false })
    expect(noticesAt(taken, current)).toBe(artifactsNotice)
    expect(quietly(taken.nudges).nudge).toBe(false)
  })

  it("shows the current description later, to update only if it no longer fits", () => {
    const text = nudgeText({ summary: "Builds the users API.\nThen paging." })
    expect(text).toBe(
      "Novadeck: automatic notice, not from the user: this terminal's summary is " +
        '"Builds the users API. Then paging."; if that no longer fits your work, ' +
        "update it with Novadeck's summarize tool, and otherwise this notice can be ignored.",
    )
  })
})
