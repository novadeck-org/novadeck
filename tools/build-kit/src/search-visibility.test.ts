import { describe, expect, it } from "vitest"

import { searchVisibility, withNoindex } from "./search-visibility.ts"

const html = "<html><head><title>x</title></head><body></body></html>"
const tag = '<meta name="robots" content="noindex" />'

describe("withNoindex", () => {
  it("asks search engines not to index the page, at the end of its head", () => {
    expect(withNoindex(html)).toBe(
      `<html><head><title>x</title>  ${tag}\n  </head><body></body></html>`,
    )
  })

  it("fails a page with no head", () => {
    expect(() => withNoindex("<body></body>")).toThrow("no head")
  })
})

describe("searchVisibility", () => {
  const transform = (mode: string): string => {
    const plugin = searchVisibility({ hidden: (each) => each === "try" })
    ;(plugin.configResolved as (config: { mode: string }) => void)({ mode })
    return (plugin.transformIndexHtml as (html: string) => string)(html)
  }

  it("marks the builds it hides", () => {
    expect(transform("try")).toContain(tag)
  })

  it("leaves any other build's page as it is", () => {
    expect(transform("production")).toBe(html)
  })
})
