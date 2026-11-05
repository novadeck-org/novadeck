import { describe as context, describe, expect, it } from "vitest"

import { createKept } from "./kept.js"

describe("what an app keeps", () => {
  it("gives back what was kept by its key", () => {
    const kept = createKept<string>(2)
    kept.keep("plan", "first")
    expect(kept.get("plan")).toBe("first")
    expect(kept.get("other")).toBeUndefined()
  })

  it("keeps the latest value for a key", () => {
    const kept = createKept<string>(2)
    kept.keep("plan", "first")
    kept.keep("plan", "second")
    expect(kept.get("plan")).toBe("second")
  })

  it("lets go of what was used longest ago past its limit, reading it counting as use", () => {
    const kept = createKept<string>(2)
    kept.keep("a", "a")
    kept.keep("b", "b")
    kept.get("a")
    kept.keep("c", "c")
    expect(kept.get("b")).toBeUndefined()
    expect(kept.get("a")).toBe("a")
  })

  it("lets go of what was kept longest ago past its limit", () => {
    const kept = createKept<string>(2)
    kept.keep("a", "a")
    kept.keep("b", "b")
    kept.keep("a", "a again")
    kept.keep("c", "c")
    expect(kept.get("b")).toBeUndefined()
    expect(kept.get("a")).toBe("a again")
    expect(kept.get("c")).toBe("c")
  })

  context("measured by size", () => {
    const sized = () => createKept<string>(10, (value) => value.length)

    it("lets go of what was used longest ago once the sizes pass the limit", () => {
      const kept = sized()
      kept.keep("a", "aaaa")
      kept.keep("b", "bbbb")
      kept.keep("c", "cccc")
      expect(kept.get("a")).toBeUndefined()
      expect([kept.get("b"), kept.get("c")]).toEqual(["bbbb", "cccc"])
    })

    it("counts a key kept again once, at its new size", () => {
      const kept = sized()
      kept.keep("a", "aaaa")
      kept.keep("a", "aaaa")
      kept.keep("a", "aa")
      kept.keep("b", "bbbb")
      kept.keep("c", "cccc")
      expect([kept.get("a"), kept.get("b"), kept.get("c")]).toEqual(["aa", "bbbb", "cccc"])
    })

    it("lets go of a value larger than the limit, and keeps what fits after it", () => {
      const kept = sized()
      kept.keep("big", "x".repeat(11))
      expect(kept.get("big")).toBeUndefined()
      kept.keep("a", "aaaa")
      expect(kept.get("a")).toBe("aaaa")
    })
  })
})
