import { afterEach } from "vitest"

import { describe, expect, it } from "../../../test"
import { adoptLegacy, markSeen, readSeen, seenAt, seenKey, seenStorageKey } from "./seen"

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

  it("moves a handle's mark to the peer's id once, and forgets the handle's", () => {
    const key = seenKey("p/s/01", "id-owl")
    const legacy = seenKey("p/s/01", "owl")
    const seen = adoptLegacy({ since: 1000, at: { [legacy]: 3000 } }, [[key, legacy]])
    expect(seen.at).toEqual({ [key]: 3000 })
    expect(seenAt(seen, legacy)).toBe(1000)
    // An id that has a mark keeps it; nothing to move leaves the record as it is.
    const kept = adoptLegacy({ since: 1000, at: { [key]: 4000, [legacy]: 3000 } }, [[key, legacy]])
    expect(kept.at).toEqual({ [key]: 4000 })
    expect(adoptLegacy(kept, [[key, legacy]])).toBe(kept)
  })

  it("reads as a first run when what's stored is broken", () => {
    localStorage.setItem(seenStorageKey, "{not json")
    expect(readSeen(7000)).toEqual({ since: 7000, at: {} })
  })
})
