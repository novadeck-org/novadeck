import { describe, expect, it } from "vitest"

import { createKept } from "./kept.js"

describe("what a host keeps", () => {
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
})
