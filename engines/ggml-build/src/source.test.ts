import { describe, expect, it } from "vitest"

import { buildKeys } from "./source.ts"

const commit = "927cfce34f31707e17f2bff35c349632fb9e2c3a"
const patch = new TextEncoder().encode("--- a/server.cpp\n+++ b/server.cpp\n")

describe("the build's folders", () => {
  // Pinned: a change here moves every cached build and Windows build folder.
  it("are named by the commit and the patches' digest, shorter for Windows", () => {
    expect(buildKeys(commit, [patch])).toEqual({
      key: "927cfce34f31-26949a233165",
      short: "927cfce3-26949a",
    })
  })

  it("change with a patch, so a changed patch builds afresh", () => {
    const changed = new TextEncoder().encode("--- a/server.cpp\n+++ b/server.cpp\n+\n")
    expect(buildKeys(commit, [changed]).key).not.toBe(buildKeys(commit, [patch]).key)
    expect(buildKeys(commit, [changed]).short).not.toBe(buildKeys(commit, [patch]).short)
  })

  it("stay the same for the same commit and patches", () => {
    expect(buildKeys(commit, [patch])).toEqual(buildKeys(commit, [patch]))
  })
})
