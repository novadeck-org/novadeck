import { describe, expect, it } from "../test.js"
import { unsupported } from "./support.js"

describe("where the end-to-end suite runs", () => {
  it("runs on Linux, Windows and macOS", () => {
    expect(unsupported("linux")).toBeUndefined()
    expect(unsupported("win32")).toBeUndefined()
    expect(unsupported("darwin")).toBeUndefined()
  })

  it("says it runs nowhere else", () => {
    expect(unsupported("freebsd")).toContain("not freebsd")
  })
})
