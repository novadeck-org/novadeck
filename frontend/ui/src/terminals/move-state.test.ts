import { describe, expect, it } from "../test"
import { freshSessionName, movedWords, moveSessions, type MoveNotice } from "./move-state"

const notice = (change: Partial<MoveNotice> = {}): MoveNotice =>
  ({
    id: "n",
    projectId: "p",
    terminalId: "01",
    name: "Search index",
    session: { id: "b", name: "Nov 6, 22:11" },
    from: "a",
    result: {
      sessionId: "b",
      moved: [{ terminalId: "01", handle: "fox", was: "fox" }],
      left: null,
    },
    ...change,
  }) as MoveNotice

describe("where a terminal's menu offers to move it", () => {
  it("lists the other sessions, most recently visited first", () => {
    const sessions = [
      { id: "a", visitedAt: 5 },
      { id: "b", visitedAt: 9 },
      { id: "c", visitedAt: null },
      { id: "d", visitedAt: 7 },
    ]
    expect(moveSessions(sessions, "a").map((each) => each.id)).toEqual(["b", "d", "c"])
  })

  it("names a new session after the terminal, unique in its project", () => {
    const sessions = [{ name: "Search index" }, { name: "Search index (2)" }] as never[]
    expect(freshSessionName("Search index", sessions)).toBe("Search index (3)")
    expect(freshSessionName("Docs", sessions)).toBe("Docs")
  })
})

describe("what the toast says of a move", () => {
  it("says where it went and that it still runs", () => {
    expect(movedWords(notice())).toBe("Search index moved to Nov 6, 22:11, still running.")
  })

  it("names a new handle, the team that came along and the lead it left", () => {
    expect(
      movedWords(
        notice({
          result: {
            sessionId: "b",
            moved: [
              { terminalId: "01", handle: "wren", was: "glint" },
              { terminalId: "02", handle: "owl", was: "owl" },
            ],
            left: "11111111-1111-4111-8111-111111111111",
          },
          lead: "lynx",
        }),
      ),
    ).toBe(
      "Search index moved to Nov 6, 22:11 with 1 teammate, still running, now as @wren. It left @lynx's team.",
    )
  })

  it("says a new session for one made for it, and why a refused move didn't happen", () => {
    expect(movedWords(notice({ fresh: true }))).toBe(
      "Search index moved to a new session, still running.",
    )
    expect(movedWords(notice({ failed: "It's closing.", result: undefined }))).toBe(
      "Couldn't move Search index to Nov 6, 22:11. It's closing.",
    )
  })
})
