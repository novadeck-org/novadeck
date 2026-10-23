import { afterEach } from "vitest"

import { describe, expect, it } from "../../../test"
import { markSeen, readSeen, seenAt, seenKey, seenStorageKey } from "./seen"

afterEach(() => localStorage.removeItem(seenStorageKey))

describe("when the person last saw a conversation", () => {
  it("counts everything before the pane first ran as seen", () => {
    const seen = readSeen(1000)
    expect(seenAt(seen, seenKey("p/s/01", "t-owl"))).toBe(1000)
  })

  it("keeps the first run's time across later reads", () => {
    readSeen(1000)
    expect(readSeen(5000).since).toBe(1000)
  })

  it("moves on as the person opens it, never back", () => {
    const key = seenKey("p/s/01", "t-owl")
    const seen = markSeen(readSeen(1000), key, 3000)
    expect(seenAt(seen, key)).toBe(3000)
    expect(markSeen(seen, key, 2000)).toBe(seen)
    expect(seenAt(seen, seenKey("p/s/01", "t-fox"))).toBe(1000)
  })

  it("reads as a first run when what's stored is broken", () => {
    localStorage.setItem(seenStorageKey, "{not json")
    expect(readSeen(7000)).toEqual({ since: 7000, at: {} })
  })
})
