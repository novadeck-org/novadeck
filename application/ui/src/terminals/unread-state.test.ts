import { describe, expect, it } from "../test"
import {
  clearUnread,
  keepUnread,
  markUnread,
  noUnread,
  unreadEnd,
  viewUnread,
  type Viewing,
} from "./unread-state"

const here = "project/initial"
const there = "project/other"

describe("unread replies", () => {
  it("marks a terminal whose agent finished while the person looked elsewhere", () => {
    const unread = markUnread(noUnread, here, "02", "done", { context: here, id: "01" })
    expect(unreadEnd(unread, here, "02")).toBe("done")
    expect(unreadEnd(unread, here, "01")).toBeUndefined()
    expect(unreadEnd(unread, there, "02")).toBeUndefined()
  })

  it("marks one that finished while the page had no focus", () => {
    expect(unreadEnd(markUnread(noUnread, here, "01", "done", null), here, "01")).toBe("done")
  })

  it("leaves one the person was looking at as it finished", () => {
    expect(markUnread(noUnread, here, "01", "done", { context: here, id: "01" })).toBe(noUnread)
  })

  it("keeps how the latest finish ended, and marks a terminal once", () => {
    const done = markUnread(noUnread, here, "02", "done", null)
    expect(markUnread(done, here, "02", "done", null)).toBe(done)
    expect(unreadEnd(markUnread(done, here, "02", "failed", null), here, "02")).toBe("failed")
  })

  it("clears once the person looks at it, and only that terminal", () => {
    const unread = markUnread(
      markUnread(noUnread, here, "01", "done", null),
      here,
      "02",
      "failed",
      null,
    )
    const viewing: Viewing = { context: here, id: "02" }
    const viewed = viewUnread(unread, viewing)
    expect(unreadEnd(viewed, here, "02")).toBeUndefined()
    expect(unreadEnd(viewed, here, "01")).toBe("done")
    expect(viewUnread(viewed, viewing)).toBe(viewed)
    expect(viewUnread(viewed, null)).toBe(viewed)
  })

  it("clears its session's entry with its last terminal", () => {
    expect(clearUnread(markUnread(noUnread, there, "03", "done", null), there, "03")).toEqual({})
  })

  it("forgets terminals that are gone", () => {
    const unread = markUnread(
      markUnread(noUnread, here, "01", "done", null),
      there,
      "03",
      "done",
      null,
    )
    expect(keepUnread(unread, (context) => context === here)).toEqual({ [here]: { "01": "done" } })
    expect(keepUnread(unread, () => true)).toBe(unread)
  })
})
