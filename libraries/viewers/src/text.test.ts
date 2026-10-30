import { describe, expect, it } from "vitest"

import { outline } from "./text.js"

describe("the outline", () => {
  it("lists second- and third-level headings with where they start, skipping fences", () => {
    const text = "# Title\n\n## One\n```\n## Not\n```\n### Two\n"
    expect(outline(text)).toEqual([
      { text: "One", at: text.indexOf("## One"), depth: 2 },
      { text: "Two", at: text.indexOf("### Two"), depth: 3 },
    ])
  })
})
