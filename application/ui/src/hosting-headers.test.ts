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

  it("keeps the posters only briefly, since their names stay the same", () => {
    expect(lines.slice(5, 7)).toEqual(["/poster-*", "  Cache-Control: public, max-age=300"])
  })

  it("sets no header under two rules, which Cloudflare would join", () => {
    const names = lines.filter((line) => line.startsWith("  ")).map((line) => line.split(":")[0])
    const cached = names.filter((name) => name === "  Cache-Control")
    // /assets/* and /poster-* never match the same path, so each file has one.
    expect(cached).toHaveLength(2)
    expect(new Set(names).size).toBe(3)
  })
})
