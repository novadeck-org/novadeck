import { describe, expect, it } from "../../test"
import { isNewerVersion } from "./versions"

describe("which version is newer", () => {
  it("compares numbers, not text", () => {
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true)
    expect(isNewerVersion("0.9.0", "0.10.0")).toBe(false)
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false)
  })

  it("puts a release above its prereleases", () => {
    expect(isNewerVersion("1.0.0", "1.0.0-beta.1")).toBe(true)
    expect(isNewerVersion("1.0.0-beta.1", "1.0.0")).toBe(false)
    expect(isNewerVersion("1.0.0-beta.2", "1.0.0-beta.1")).toBe(true)
  })

  it("is false for what is not a release's version", () => {
    expect(isNewerVersion("x", "1.0.0")).toBe(false)
    expect(isNewerVersion("2.0.0", "x")).toBe(false)
  })
})
