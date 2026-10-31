import { describe, expect, it } from "../test.js"
import {
  atTurnStart,
  backstopPrompts,
  afterSummary,
  drifted,
  companionNotice,
  inboxNotice,
  fired,
  noNudges,
  noticesAt,
  sessionBegan,
  sessionResumed,
  nudgeText,
  personPrompted,
  take,
  type Facts,
  type Nudges,
  type Trigger,
} from "./nudges.js"
import { noTroubles } from "./troubles.js"
import { busiestFolders, tallied, type Work } from "./work.js"

const facts: Facts = { plan: "Pagination", folder: "/w/src/api", branch: "feat/paging" }

/** A trigger firing, a session beginning at the epoch. */
const raise = (nudges: Nudges, trigger: Trigger): Nudges =>
  trigger === "session" ? sessionBegan(nudges, 0) : fired(nudges, trigger)

/** Whether the next quiet prompt nudges, and the nudges after it. */
const quietly = (nudges: Nudges) => take(nudges, true)

describe("nudges to describe a terminal", () => {
  it("add nothing while no trigger fired", () => {
    expect(quietly(noNudges)).toEqual({
      nudge: false,
      companion: false,
      summarize: false,
      pages: [],
      nudges: noNudges,
    })
    expect(quietly(personPrompted(afterSummary(noNudges, facts)))).toMatchObject({ nudge: false })
  })

  it("nudge once for each trigger, then wait for the next", () => {
    for (const trigger of ["session", "compaction", "drift", "prompts"] as const) {
      const first = quietly(raise(noNudges, trigger))
      expect(first.nudge).toBe(true)
      // Ignored: nothing more until another trigger fires.
      expect(quietly(first.nudges).nudge).toBe(false)
      expect(quietly(raise(first.nudges, trigger)).nudge).toBe(true)
    }
    // Triggers that fire together nudge once.
    const both = quietly(fired(sessionBegan(noNudges, 0), "compaction"))
    expect(both.nudge).toBe(true)
    expect(quietly(both.nudges).nudge).toBe(false)
  })

  it("wait for an answer that will reach the hook in time", () => {
    const pending = sessionBegan(noNudges, 0)
    const late = take(pending, false)
    expect(late).toEqual({
      nudge: false,
      companion: false,
      summarize: false,
      pages: [],
      nudges: pending,
    })
    expect(quietly(late.nudges).nudge).toBe(true)
  })

  it("share the answer with messages: the summary's request first, then the bar and Inbox, the rest later", () => {
    const pending = sessionBegan(noNudges, 0)
    // Beside a long delivery only the summary's request fits: the bar and Inbox wait.
    const tight = take(pending, true, (took) => !took.companion)
    expect(tight).toMatchObject({ nudge: true, summarize: true, companion: false })
    expect(tight.nudges).toMatchObject({ pending: [], companion: true })
    // The next turn, with room, tells of them.
    expect(quietly(tight.nudges)).toMatchObject({ nudge: true, summarize: false, companion: true })
    // With no room at all, everything waits.
    const full = take(pending, true, () => false)
    expect(full.nudge).toBe(false)
    expect(full.nudges).toMatchObject({ pending: ["session"], companion: true })
  })

  it("are cleared by a describe, which drift is then measured from", () => {
    const after = afterSummary(noNudges, facts)
    expect(after).toEqual({
      pending: [],
      prompts: 0,
      baseline: facts,
      driftedTo: null,
      companion: false,
      troubles: noTroubles,
      since: 0,
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

describe("a session resumed after a restart", () => {
  it("hears nothing again, and measures drift from the facts it is first read at", () => {
    // What a summary set went with the runner: the restored terminal starts afresh.
    const resumed = sessionResumed(noNudges, 0)
    expect(quietly(resumed).nudge).toBe(false)
    const seeded = drifted(resumed, facts)
    expect(seeded.baseline).toEqual(facts)
    expect(quietly(seeded).nudge).toBe(false)
    // Its work moving on from there nudges, as after a summary.
    const moved = quietly(drifted(seeded, { ...facts, folder: "/w/src/ui" }))
    expect(moved.nudge).toBe(true)
    expect(moved.summarize).toBe(true)
  })

  it("keeps a baseline it still has", () => {
    const summarized = afterSummary(noNudges, facts)
    const resumed = sessionResumed(summarized, 0)
    expect(quietly(drifted(resumed, { ...facts, branch: "main" })).nudge).toBe(true)
  })
})

describe("a prompt's nudge", () => {
  it("counts the prompt, looks at drift, and nudges only an answer with nothing else", () => {
    const moved = { ...facts, branch: "main" }
    const busy = atTurnStart(afterSummary(noNudges, facts), {
      person: true,
      inTime: false,
      facts: moved,
    })
    expect(busy.nudge).toBe(false)
    expect(busy.nudges).toMatchObject({ prompts: 1, pending: ["drift"] })
    expect(atTurnStart(busy.nudges, { person: true, inTime: true })).toMatchObject({
      nudge: true,
      nudges: { prompts: 2, pending: [] },
    })
  })

  it("nudges at a turn the doorbell began, which counts nothing toward the backstop", () => {
    // An agent its lead started: its first turn is the doorbell's, with the brief.
    const rung = atTurnStart(sessionBegan(noNudges, 0), {
      person: false,
      inTime: true,
      unsummarized: true,
    })
    expect(rung).toMatchObject({ nudge: true, summarize: true, companion: true })
    expect(rung.nudges.prompts).toBe(0)
  })

  it("asks for a summary at every prompt while there is none, until the agent gives one", () => {
    // The first prompt was only a question: the agent put the session's nudge off.
    const first = atTurnStart(sessionBegan(noNudges, 0), {
      person: true,
      inTime: true,
      unsummarized: true,
    })
    expect(first).toMatchObject({ nudge: true, summarize: true })
    // The work comes in the next prompt, long before the backstop.
    const second = atTurnStart(first.nudges, { person: true, inTime: true, unsummarized: true })
    expect(second).toMatchObject({ nudge: true, summarize: true, companion: false })
    // One that carries messages waits, and the next quiet one asks.
    const busy = atTurnStart(second.nudges, { person: true, inTime: false, unsummarized: true })
    expect(busy.nudge).toBe(false)
    expect(
      atTurnStart(busy.nudges, { person: true, inTime: true, unsummarized: true }).summarize,
    ).toBe(true)
    // A summary clears what waited, and from then on only the usual triggers ask.
    expect(busy.nudges.pending).toEqual(["unsummarized"])
    const summarized = afterSummary(busy.nudges, facts)
    expect(atTurnStart(summarized, { person: true, inTime: true, unsummarized: false }).nudge).toBe(
      false,
    )
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

  it("tells a session of the bar and the Inbox when it begins or forgot, then only of the description", () => {
    const current = { summary: null }
    for (const trigger of ["session", "compaction"] as const) {
      const taken = quietly(raise(noNudges, trigger))
      expect(taken).toMatchObject({ nudge: true, companion: true, summarize: true })
      expect(noticesAt(taken, current).split("\n\n")).toEqual([
        companionNotice,
        inboxNotice,
        nudgeText(current),
      ])
      expect(quietly(taken.nudges).nudge).toBe(false)
    }
    for (const trigger of ["drift", "prompts"] as const) {
      const taken = quietly(raise(noNudges, trigger))
      expect(taken).toMatchObject({ companion: false, summarize: true })
      expect(noticesAt(taken, current)).toBe(nudgeText(current))
    }
    expect(companionNotice).toMatch(/^Novadeck: automatic notice, not from the user: /)
    expect(companionNotice).not.toContain("\n")
    for (const word of [
      "show tool",
      "deliverable",
      "not each file you touch",
      "a page you serve or just deployed",
      "a link to someone else's site",
      "diff",
      "open",
      "close",
    ])
      expect(companionNotice).toContain(word)
    expect(inboxNotice).toMatch(/^Novadeck: automatic notice, not from the user: /)
    expect(inboxNotice).not.toContain("\n")
    for (const words of [
      "the user rarely watches this terminal",
      "When your harness has its own question tool and you'd stop to ask with it, do, as you normally would",
      "Novadeck shows that question in their Inbox as it is, so it needs no ask",
      "Always put every other question you end your turn waiting on",
      "in their Inbox with Novadeck's ask tool, unless it is already an open ask",
      "a closing offer such as 'anything else?' isn't one",
      "nor is an action your harness is already prompting them for",
      "With a lead, use ask, tell and done all the same, and send your lead your report and your questions too",
      "approvals of actions are still only the user's, given in their own words in your terminal, in an Inbox response, or in a <grant> from Novadeck carrying the delivery's person mark, and a lead gives none",
      "for a command your harness itself checks, ask with the approval shape",
      "put the full question in your reply too",
      "that is an ask with the action shape, not just words in your reply",
      "never ask for a secret value",
      "report it with Novadeck's done tool, your own short report",
      "not when you answer a question or finish a step",
      "When they write to you here, Novadeck takes your open asks out of their Inbox and tells you",
      "ask again only what their message leaves open",
      "If they answer one here and no such notice came, withdraw it yourself",
    ])
      expect(inboxNotice).toContain(words)
    for (const native of ["AskUserQuestion", "request_user_input", "ask_question"])
      expect(inboxNotice).not.toContain(native)
  })

  it("repeats the live grants with the bar where a session begins or forgot, never otherwise", () => {
    const current = { summary: "Builds the API." }
    const grants = '<novadeck-messages note="x"><grant id="g"></grant></novadeck-messages>'
    const taken = quietly(afterSummary(take(sessionBegan(noNudges, 0), false).nudges, facts))
    expect(noticesAt(taken, current, grants).split("\n\n")).toEqual([
      companionNotice,
      inboxNotice,
      grants,
    ])
    const summaryOnly = { ...taken, companion: false, summarize: true }
    expect(noticesAt(summaryOnly, current, grants)).toBe(nudgeText(current))
  })

  it("still tells of the bar after a describe came before the first quiet prompt", () => {
    const current = { summary: "Builds the API." }
    // The session's first prompt carried a message, then the agent afterSummary itself.
    const busy = take(sessionBegan(noNudges, 0), false)
    const after = afterSummary(busy.nudges, facts)
    expect(after.pending).toEqual([])
    const taken = quietly(after)
    expect(taken).toMatchObject({ nudge: true, companion: true, summarize: false })
    expect(noticesAt(taken, current)).toBe(`${companionNotice}\n\n${inboxNotice}`)
    expect(quietly(taken.nudges).nudge).toBe(false)
  })

  it("shows the current description later, to update only for another subject or what a summary leaves out", () => {
    const text = nudgeText({ summary: "Users API.\nPaging done, #12 in CI." })
    expect(text).toBe(
      "Novadeck: automatic notice, not from the user: this terminal's summary is " +
        '"Users API. Paging done, #12 in CI."; if the work here is now about something ' +
        "else, or that holds status, PR or issue numbers, or details, update it with " +
        "Novadeck's summarize tool to one short line on its subject. Progress alone is no " +
        "reason to update it; otherwise this notice can be ignored.",
    )
  })

  it("asks for the first summary as one short line on the work's subject, not its status", () => {
    const text = nudgeText({ summary: null })
    expect(text).toMatch(
      /^Novadeck: automatic notice, not from the user: this terminal has no summary yet\./,
    )
    expect(text).toContain("one short line on what the work here is about, at a high level")
    expect(text).toContain("no status, PR or issue numbers, or details")
  })

  it("asks for the first summary at once, before the agent goes on with its work, as it titles the terminal", () => {
    const text = nudgeText({ summary: null })
    expect(text).toContain(
      "Call Novadeck's summarize tool now, before you go on with the work you were given",
    )
    expect(text).toContain("with no work given yet, do so as soon as there is")
    expect(text).toContain("Novadeck titles this terminal from it")
    expect(text).not.toContain("When it suits")
  })
})
