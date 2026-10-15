import { tryHeaders } from "./hosting-headers"
import { describe, expect, it } from "./test"

describe("the visitor build's hosting headers", () => {
  const lines = tryHeaders().split("\n")

  it("lets only the website frame the demo", () => {
    expect(lines).toContain(
      "  Content-Security-Policy: frame-ancestors 'self' https://novadeck.dev",
    )
  })

  it("keeps every file out of search results", () => {
    expect(lines.slice(0, 3)).toEqual([
      "/*",
      expect.stringContaining("frame-ancestors"),
      "  X-Robots-Tag: noindex",
    ])
  })

  it("lets browsers keep hashed assets for good", () => {
    expect(lines.slice(3, 5)).toEqual([
      "/assets/*",
      "  Cache-Control: public, max-age=31536000, immutable",
    ])
  })
})
