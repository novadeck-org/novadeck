import { describe, expect, it } from "../test"
import { firstFamily } from "./theme-font"

describe("firstFamily", () => {
  it("is the first family of a chain, without its quotes", () => {
    expect(firstFamily('"Share Tech Mono", "JetBrains Mono Variable", monospace')).toBe(
      "Share Tech Mono",
    )
    expect(firstFamily("'JetBrains Mono Variable', Consolas")).toBe("JetBrains Mono Variable")
    expect(firstFamily("\n    Menlo, monospace")).toBe("Menlo")
  })

  it("is empty for no chain", () => {
    expect(firstFamily("")).toBe("")
  })
})
