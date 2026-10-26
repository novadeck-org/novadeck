import type { InboxTurn } from "@novadeck/core/inbox"

import { describe, expect, it } from "../test"
import { noUnread, sameUnread, unreadEnd, unreadOfTurns } from "./unread-state"

const row = (
  id: string,
  terminalId: string,
  at: number,
  outcome: InboxTurn["outcome"],
): InboxTurn => ({
  id,
  projectId: "project",
  workspaceSessionId: "initial",
  terminalId,
  handle: "fox",
  agent: "claude",
  at,
  outcome,
  reply: null,
  error: null,
  files: [],
})

describe("unread replies", () => {
  it("marks each terminal with rows by how its newest row ended", () => {
    const unread = unreadOfTurns([
      row("a", "02", 10, "failed"),
      row("b", "02", 20, "completed"),
      row("c", "03", 5, "failed"),
    ])
    expect(unreadEnd(unread, "project/initial", "02")).toBe("unread")
    expect(unreadEnd(unread, "project/initial", "03")).toBe("failed")
    expect(unreadEnd(unread, "project/initial", "01")).toBeUndefined()
    expect(unreadEnd(unread, "project/other", "02")).toBeUndefined()
  })

  it("takes the newest row whatever the order the backend lists them in", () => {
    const unread = unreadOfTurns([row("b", "02", 20, "completed"), row("a", "02", 10, "failed")])
    expect(unreadEnd(unread, "project/initial", "02")).toBe("unread")
  })

  it("marks nothing for no rows", () => {
    expect(unreadOfTurns([])).toEqual(noUnread)
  })

  it("tells marks that say the same", () => {
    const one = unreadOfTurns([row("a", "02", 10, "failed")])
    expect(sameUnread(one, unreadOfTurns([row("z", "02", 99, "failed")]))).toBe(true)
    expect(sameUnread(one, unreadOfTurns([row("a", "02", 10, "completed")]))).toBe(false)
    expect(sameUnread(one, unreadOfTurns([row("a", "03", 10, "failed")]))).toBe(false)
    expect(sameUnread(one, noUnread)).toBe(false)
  })
})
