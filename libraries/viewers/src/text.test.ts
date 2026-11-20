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

  it("skips what a tilde fence holds, and what a longer fence holds that has a shorter one inside", () => {
    expect(outline("~~~\n## Not\n~~~\n## Real\n").map((heading) => heading.text)).toEqual(["Real"])
    // A Markdown sample in four backticks, with a triple-backtick block of its own in it.
    expect(
      outline("````md\n```\n## Not\n```\n## Nor\n````\n## Real\n").map((heading) => heading.text),
    ).toEqual(["Real"])
    // The other kind of fence doesn't close it; a fence that never closes runs to the end.
    expect(outline("~~~\n```\n## Not\n~~~\n## Real\n").map((heading) => heading.text)).toEqual([
      "Real",
    ])
    expect(outline("```\n## Not\n").map((heading) => heading.text)).toEqual([])
    // A backtick run with more after it on its line is inline code, not a fence.
    expect(outline("```a``` b\n## Real\n").map((heading) => heading.text)).toEqual(["Real"])
  })
})
