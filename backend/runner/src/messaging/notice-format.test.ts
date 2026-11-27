import {
  noticeBody,
  noticeOneLine,
  noticesSeen,
  readNotice,
  splitHookText,
} from "@novadeck/protocol/notices"
import { describe, expect, it } from "vitest"

import { closeNotice } from "../terminals/closes.js"
import { leadNotice } from "../terminals/leads.js"
import { moveNotice } from "../terminals/moves.js"
import {
  companionNotice,
  inboxNotice,
  nudgeText,
  worktreesEarlyNotice,
  worktreesOffNotice,
  worktreesOnNotice,
} from "../terminals/nudges.js"
import { runNotice } from "../terminals/runs.js"
import { teamNotice } from "../terminals/teams.js"
import { worktreeNotice } from "../worktrees/calls.js"
import { mainNotice } from "../worktrees/main-notice.js"
import { holdFact, holdNotice } from "./holds.js"
import { dismissedNotice, withdrawnNotice } from "./inbox.js"
import { noticeKinds, noticeLines, noticePrefix, noticeText } from "./notice-format.js"

describe("noticeText", () => {
  it("is a header, the facts, indented details and an arrow line per action", () => {
    expect(
      noticeText("Worktrees", {
        facts: "@newtz gave you its worktree. It's yours now.",
        details: ["/home/me/work"],
        actions: ["Work there with absolute paths.", "Don't close it."],
      }),
    ).toBe(
      [
        "Novadeck · Worktrees",
        "@newtz gave you its worktree. It's yours now.",
        "  /home/me/work",
        "→ Work there with absolute paths.",
        "→ Don't close it.",
      ].join("\n"),
    )
  })

  it("has no arrow line where there is nothing to do", () => {
    expect(noticeText("Resources", { facts: "CPU at 90%+ for 3 min." })).toBe(
      "Novadeck · Resources\nCPU at 90%+ for 3 min.",
    )
    expect(noticeLines({ facts: "x" })).toEqual(["x"])
  })

  it("starts with a middle dot between single spaces", () => {
    expect(noticePrefix).toBe("Novadeck · ")
  })
})

describe("every notice Novadeck words", () => {
  const texts: readonly string[] = [
    nudgeText({ summary: null, title: null }),
    nudgeText({ summary: "Builds the API.", title: null }),
    nudgeText({ summary: "Builds the API.", title: "API" }),
    companionNotice,
    inboxNotice,
    worktreesOnNotice,
    worktreesOffNotice,
    worktreesEarlyNotice,
    withdrawnNotice(["Which palette?"]),
    dismissedNotice([{ subject: "Which palette?", action: "options" }]),
    holdNotice(["m-1"], "fox", "draft", 0),
    closeNotice.confirmed("fox", "api", "Codex"),
    closeNotice.gone("fox"),
    runNotice.opened("dev", "pnpm dev"),
    runNotice.gone("pnpm dev"),
    leadNotice.nowLed("newtz"),
    leadNotice.openedLed("newtz"),
    leadNotice.released("newtz"),
    leadNotice.led("fox", "api", { ok: false, reason: "No window." }),
    teamNotice.joined("fox", "api", true),
    teamNotice.nowJoined("newtz", "api"),
    teamNotice.newLead("newtz", "hushz", true),
    moveNotice.left("newtz", [{ was: "fox", now: "fox2" }]),
    moveNotice.alone(),
    worktreeNotice.given("newtz", "/w/x", "fix/x"),
    worktreeNotice.lost("hushz", "/w/x", "fix/x"),
    mainNotice("api", {
      from: "a",
      to: "b",
      at: 0,
      commits: 1,
      merges: [],
      files: ["src/a.ts"],
      filesTotal: 1,
      dependencies: null,
      latest: [],
      dependenciesLatest: false,
    }),
  ]

  it("opens with `Novadeck · <Kind>` of a listed kind, and says nothing of where it comes from", () => {
    for (const text of texts) {
      const [header, ...rest] = text.split("\n")
      expect(noticeKinds.map((kind) => `${noticePrefix}${kind}`)).toContain(header)
      expect(rest.length).toBeGreaterThan(0)
      expect(text).not.toMatch(/automatic notice|needs no (other )?reply|notice can be ignored/)
    }
  })

  it("keeps a lead's report-back as an action, and its standing rules out of the event", () => {
    expect(leadNotice.nowLed("newtz")).toBe(
      "Novadeck · Team\nThe user let @newtz lead you from now on.\n→ Report back to it with send when you're done or stuck.",
    )
    for (const text of [leadNotice.nowLed("newtz"), leadNotice.released("newtz")])
      expect(text).not.toMatch(/still stands|lead mark|peer's/)
  })

  it("embeds a hold in the lead notice as a fact, never as a second notice, with the retry as an action", () => {
    const hold = holdFact(["m-1"], "fox", "draft", 0)
    const text = leadNotice.led("fox", "api", {
      ok: true,
      text: `Your brief matched message m-1. ${hold}`,
      again: "Send it again in a few seconds.",
    })
    expect(text.match(/Novadeck · /g)).toHaveLength(1)
    expect(text).toContain(hold)
    expect(text.endsWith("\n→ Send it again in a few seconds.")).toBe(true)
  })

  // The chat and the terminal overlay take a notice apart by `@novadeck/protocol/notices`, which
  // must read exactly what this module builds.
  it("is read back whole by the one rule that strips its header", () => {
    for (const text of texts) {
      const { kind, facts, actions } = readNotice(text)
      expect(noticeKinds).toContain(kind)
      expect(facts.length).toBeGreaterThan(0)
      expect(facts.join("\n")).not.toContain(noticePrefix)
      // Header off, nothing else lost: the header and the body make the text again.
      expect(`${noticePrefix}${kind}\n${noticeBody(text)}`).toBe(text)
      expect(noticeOneLine(text)).not.toMatch(/\n|Novadeck · /)
      for (const action of actions) expect(text).toContain(`\n→ ${action}`)
    }
  })

  // On the hook, worktrees going off is the same kind as their standing notice: the person's line
  // tells it apart by its facts.
  it("reads worktrees turned off to the person as off, never on or a briefing", () => {
    const hook = (...each: string[]) => noticesSeen(each.map((text) => ({ text, standing: true })))
    expect(hook(worktreesOffNotice)).toBe("You notice agent worktrees are off.")
    expect(hook(worktreesOnNotice)).toBe("You notice agent worktrees are on.")
    expect(hook(worktreesEarlyNotice)).toBe("You notice agent worktrees are on.")
    expect(hook(companionNotice, inboxNotice, worktreesOnNotice)).toBe("You notice a briefing.")
  })

  it("splits a hook's text back into the notices it joined, a blank line apart", () => {
    expect(splitHookText(texts.join("\n\n"))).toEqual({ notices: texts, delivery: false })
  })

  it("keeps a delivery apart from the notices printed with it, either side of it", () => {
    const delivery =
      '<novadeck-messages note="Rules.">\n<message id="m-a" from="fox">Done.</message>\n</novadeck-messages>'
    const [first, second] = texts
    expect(splitHookText(`${delivery}\n\n${first}\n\n${second}`)).toEqual({
      notices: [first, second],
      delivery: true,
    })
    expect(splitHookText(`${first}\n\n${delivery}`)).toEqual({ notices: [first], delivery: true })
    expect(splitHookText(delivery)).toEqual({ notices: [], delivery: true })
  })
})
