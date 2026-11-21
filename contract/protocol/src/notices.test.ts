import { describe, expect, it } from "vitest"

import { noticeBody, noticeOneLine, readNotice, splitHookText } from "./notices.js"

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
  const host = "Novadeck · Host load\nCPU at 90%+ for 3 min."

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
