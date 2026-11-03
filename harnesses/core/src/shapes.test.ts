import { describe, expect, it } from "vitest"

import { classify, leadingTag, tagKeys, unknownShapes } from "./shapes.js"

describe("a text's leading tag", () => {
  it("names a tag the text opens with and closes further on", () => {
    expect(leadingTag("<command-name>/mcp</command-name>")).toBe("command-name")
    expect(leadingTag('\n\n<pasted_content id="4f2a">\nx\n</pasted_content id="4f2a">\n')).toBe(
      "pasted_content",
    )
    expect(leadingTag('<hook_prompt hook_run_id="stop:1">go on</hook_prompt>')).toBe("hook_prompt")
  })

  it("is none for plain text, a tag left open, or a tag further in", () => {
    expect(leadingTag("Fix the tests")).toBeUndefined()
    expect(leadingTag("<text>")).toBeUndefined()
    expect(leadingTag("<div> is a block")).toBeUndefined()
    expect(leadingTag("Read <b>this</b>")).toBeUndefined()
    expect(tagKeys("plain")).toEqual([])
    expect(tagKeys("<skill>x</skill>")).toEqual(["tag:skill"])
  })
})

describe("shape lists", () => {
  const verdicts = classify({ read: ["record:user"], skipped: ["record:system"] })

  it("give each key once, read, skipped or unknown", () => {
    expect(verdicts(["record:user", "record:system", "record:new", "record:user"])).toEqual([
      { key: "record:user", verdict: "read" },
      { key: "record:system", verdict: "skipped" },
      { key: "record:new", verdict: "unknown" },
    ])
  })

  it("count the lines that hold each unknown shape", () => {
    const shapes = (line: string) => verdicts(line.split(" "))
    expect([
      ...unknownShapes(shapes, ["record:user record:new", "record:new", "record:system"]),
    ]).toEqual([["record:new", 2]])
  })
})
