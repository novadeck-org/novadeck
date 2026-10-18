import { describe, expect, it } from "vitest"

import { fontsAsFiles } from "./fonts.ts"

describe("fontsAsFiles", () => {
  it("never inlines a font", () => {
    expect(fontsAsFiles("assets/inter-latin.woff2")).toBe(false)
    expect(fontsAsFiles("assets/inter-latin.woff")).toBe(false)
  })

  it("leaves other assets to Vite's own limit", () => {
    expect(fontsAsFiles("assets/logo.svg")).toBeUndefined()
  })
})
