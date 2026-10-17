import { describe, expect, it } from "vitest"

import { isLibraryName } from "./template.ts"

describe("a new library's name", () => {
  it("is lower-case words joined by hyphens", () => {
    expect(isLibraryName("tui-input", [])).toBe(true)
    expect(isLibraryName("TuiInput", [])).toBe(false)
    expect(isLibraryName("tui--input", [])).toBe(false)
    expect(isLibraryName("-tui", [])).toBe(false)
  })

  it("is no workspace package's, and never a harness's", () => {
    expect(isLibraryName("ui", ["ui", "runner"])).toBe(false)
    expect(isLibraryName("harness-kit", [])).toBe(false)
  })
})
