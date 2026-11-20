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

  it("opens a tilde fence whose info string holds a backtick, which only a backtick fence forbids", () => {
    // Read otherwise, the body is text, the closing ~~~ opens a fence, and what follows is hidden.
    expect(outline("~~~ `x`\n## Inside\n~~~\n## After\n").map((heading) => heading.text)).toEqual([
      "After",
    ])
  })

  it("reads a line indented four spaces or more as indented code, not a fence, outside a list", () => {
    expect(outline("    ```\n## One\n").map((heading) => heading.text)).toEqual(["One"])
    // A closing fence that deep closes nothing.
    expect(outline("```\n    ```\n## Not\n```\n## After\n").map((heading) => heading.text)).toEqual(
      ["After"],
    )
  })

  it("keeps a fence inside a list item, as deep as the item holds it", () => {
    const text = "- item\n\n      ```\n      ## Not\n      ```\n\n## After\n"
    expect(outline(text).map((heading) => heading.text)).toEqual(["After"])
    // A margin line ends the list, so a deeply indented line after it is code again.
    expect(outline("- item\n\nplain\n\n      ```\n## One\n").map((h) => h.text)).toEqual(["One"])
  })
})
