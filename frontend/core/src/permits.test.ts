import type { ChatPermit } from "./conversation"
import { permitBasis, permitStands } from "./permits"
import { describe, expect, it } from "./test"

const at = (day: number, hour: number, minute: number): number =>
  new Date(2026, 10, day, hour, minute).getTime()

const permit = (change: Partial<ChatPermit> = {}): ChatPermit => ({
  id: "p1",
  title: "Merge PR #1190 into main",
  quote: null,
  givenAt: at(23, 0, 29),
  until: at(23, 12, 29),
  usedAt: null,
  ...change,
})

describe("What a standing permit says", () => {
  it("names the person's own words, or that they allowed it on the card", () => {
    expect(permitBasis(permit({ quote: "merge it" }))).toBe('On your words: "merge it"')
    expect(permitBasis(permit())).toBe("You allowed it on its card")
  })

  it("says until when it stands, and that its first use ends it", () => {
    expect(permitStands(permit(), at(23, 1, 0))).toBe("Stands until 12:29, or its first use")
  })

  it("adds the weekday where it ends on another day than today", () => {
    expect(permitStands(permit({ until: at(24, 2, 5) }), at(23, 20, 0))).toBe(
      "Stands until Tue 02:05, or its first use",
    )
  })

  it("says when it was used and when its retry ends, once it was", () => {
    expect(
      permitStands(permit({ usedAt: at(23, 3, 10), until: at(23, 3, 20) }), at(23, 3, 11)),
    ).toBe("Used at 03:10 · ends 03:20")
  })
})
