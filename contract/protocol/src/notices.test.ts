import { describe, expect, it } from "vitest"

import {
  noticeBody,
  noticeOneLine,
  noticeSeen,
  noticesSeen,
  readNotice,
  splitHookText,
} from "./notices.js"

const worktrees = [
  "Novadeck · Worktrees",
  "@newtz gave you its worktree on fix/x.",
  "  /home/me/work",
  "→ Work there with absolute paths.",
  "→ Don't close it.",
].join("\n")

describe("readNotice", () => {
  it("drops the header and splits the facts, details and actions", () => {
    expect(readNotice(worktrees)).toEqual({
      kind: "Worktrees",
      facts: ["@newtz gave you its worktree on fix/x.", "  /home/me/work"],
      actions: ["Work there with absolute paths.", "Don't close it."],
    })
  })

  it("keeps the actions on their own lines in the body, and runs on in one line", () => {
    expect(noticeBody(worktrees)).toBe(
      "@newtz gave you its worktree on fix/x.\n  /home/me/work\n→ Work there with absolute paths.\n→ Don't close it.",
    )
    expect(noticeOneLine(worktrees)).toBe(
      "@newtz gave you its worktree on fix/x. /home/me/work → Work there with absolute paths. → Don't close it.",
    )
  })

  it("reads a notice with no header whole, and one of an earlier build's header as plain facts", () => {
    expect(readNotice("CPU at 90%+ for 3 min.")).toEqual({
      kind: null,
      facts: ["CPU at 90%+ for 3 min."],
      actions: [],
    })
    expect(
      readNotice(
        "Novadeck: automatic notice, not from the user: this terminal has no summary yet.",
      ),
    ).toEqual({ kind: null, facts: ["this terminal has no summary yet."], actions: [] })
  })
})

describe("splitHookText", () => {
  const delivery =
    '<novadeck-messages note="x">\n<message id="m-a">Hi.</message>\n</novadeck-messages>'
  const host = "Novadeck · Resources\nCPU at 90%+ for 3 min."

  it("splits notices apart at their headers", () => {
    expect(splitHookText(`${worktrees}\n\n${host}`)).toEqual({
      notices: [worktrees, host],
      delivery: false,
    })
  })

  it("reads a delivery apart from the notices beside it, and leads the Stop's phrase off", () => {
    expect(splitHookText(`Stop hook feedback:\n${delivery}\n\n${host}`)).toEqual({
      notices: [host],
      delivery: true,
    })
    expect(splitHookText(delivery)).toEqual({ notices: [], delivery: true })
  })

  it("reads no notice from text that doesn't start with one", () => {
    expect(splitHookText("Some other hook's context.\n\n" + host)).toEqual({
      notices: [],
      delivery: false,
    })
    expect(splitHookText("")).toEqual({ notices: [], delivery: false })
  })

  it("reads the notices between two deliveries, and after the last", () => {
    expect(splitHookText(`${delivery}\n\n${host}\n\n${delivery}\n\n${worktrees}`)).toEqual({
      notices: [host, worktrees],
      delivery: true,
    })
  })

  it("reads the notices after a delivery cut short, which has no closing tag", () => {
    const cut = delivery.slice(0, delivery.indexOf("</novadeck-messages>"))
    expect(splitHookText(`${cut}\n\n${host}`)).toEqual({ notices: [host], delivery: true })
    expect(splitHookText(cut)).toEqual({ notices: [], delivery: true })
  })

  it("leads the Stop's phrase off a text with no delivery, too", () => {
    expect(splitHookText(`Stop hook says: ${host}`)).toEqual({ notices: [host], delivery: false })
  })
})

describe("noticeSeen", () => {
  const of = (kind: string): string => noticeSeen(`Novadeck · ${kind}\nSomething happened.`)

  it("says one line for each family", () => {
    expect(of("Restart")).toBe("You notice Novadeck restarted.")
    expect(of("Terminals")).toBe("You notice terminals open and close.")
    expect(of("Team")).toBe("You notice the team shift.")
    expect(of("Worktrees")).toBe("You notice a worktree change hands.")
    expect(of("Inbox")).toBe("You notice an ask leave the Inbox.")
    expect(of("Resources")).toBe("You notice shared resources are busy.")
    expect(of("Show")).toBe("You notice problems in something shown.")
    expect(of("Shipping")).toBe("You notice your answer reach the agent.")
    expect(of("Messages")).toBe("You notice a message still on its way.")
    expect(of("Describe")).toBe("You notice the terminal wants a title.")
  })

  it("says what a standing notice is about, and an event's line for a kind with none of its own", () => {
    const standing = (kind: string): string =>
      noticeSeen(`Novadeck · ${kind}\nHow it works.`, { standing: true })
    expect(standing("Show")).toBe("You notice the bar beside the terminal.")
    expect(standing("Inbox")).toBe("You notice the Inbox keeps a copy.")
    expect(standing("Describe")).toBe("You notice the terminal wants a title.")
    expect(standing("Worktrees")).toBe("You notice worktrees are on.")
    expect(standing("Team")).toBe("You notice the team shift.")
  })

  it("maps the kinds earlier builds wrote to their family", () => {
    expect(of("Host load")).toBe(of("Resources"))
    expect(of("CI queue")).toBe(of("Resources"))
    expect(of("Page")).toBe(of("Show"))
    expect(of("Lead")).toBe(of("Team"))
    expect(of("Move")).toBe(of("Team"))
    expect(of("Close")).toBe(of("Terminals"))
    expect(of("Run")).toBe(of("Terminals"))
  })

  it("says something for an unknown kind or the legacy prefix, and a task for a brief with no header", () => {
    expect(of("Weather")).toBe("You notice something.")
    expect(noticeSeen("Novadeck: automatic notice, not from the user: It rained.")).toBe(
      "You notice something.",
    )
    expect(noticeSeen("This is the artist's brief for Novadeck's tour.")).toBe(
      "You notice Novadeck hand over a task.",
    )
  })
})

describe("noticesSeen", () => {
  const event = (kind: string) => ({ text: `Novadeck · ${kind}\nIt happened.` })
  const standing = (kind: string) => ({ text: `Novadeck · ${kind}\nHow it works.`, standing: true })

  it("joins the lines of notices delivered together, each once", () => {
    expect(noticesSeen([event("Team"), event("Resources"), event("Team")])).toBe(
      "You notice the team shift. · You notice shared resources are busy.",
    )
  })

  it("says several standing notices as Novadeck setting the agent up, where the first was", () => {
    expect(noticesSeen([standing("Show"), standing("Inbox"), standing("Describe")])).toBe(
      "You notice Novadeck set the agent up.",
    )
    expect(noticesSeen([event("Restart"), standing("Show"), standing("Inbox")])).toBe(
      "You notice Novadeck restarted. · You notice Novadeck set the agent up.",
    )
    expect(noticesSeen([standing("Worktrees")])).toBe("You notice worktrees are on.")
  })
})
