import { describe, expect, it } from "vitest"

import { checkOutput, maxChanges, maxPrs } from "./check.ts"
import { type ModelOutput } from "./model.ts"

const allowed = new Set([181, 195, 261])
const good: ModelOutput = {
  highlights: [{ title: "Word handles", line: "Terminals get a name like @moth.", prs: [181] }],
  changes: [{ area: "Inbox & notifications", line: "Answer agents from the Inbox.", prs: [195] }],
}
const withChange = (line: string, prs = [195], area = "Voice"): ModelOutput => ({
  ...good,
  changes: [{ area, line, prs }],
})
const failure = (output: ModelOutput) => {
  const checked = checkOutput(output, allowed)
  return checked.ok ? undefined : checked.reason
}

describe("the checks on a model's answer", () => {
  it("passes a good one untouched", () => {
    expect(checkOutput(good, allowed)).toEqual({ ok: true, output: good, dropped: [] })
  })

  it("allows a promotion with no highlights, and refuses more than four", () => {
    expect(failure({ ...good, highlights: [] })).toBeUndefined()
    expect(failure({ ...good, highlights: Array(5).fill(good.highlights[0]) })).toMatch(/At most 4/)
  })

  it("holds titles to 40 characters and lines to 110", () => {
    const title = (text: string): ModelOutput => ({
      ...good,
      highlights: [{ ...good.highlights[0]!, title: text }],
    })
    expect(failure(title("x".repeat(40)))).toBeUndefined()
    expect(failure(title("x".repeat(41)))).toMatch(/Title/)
    expect(failure(withChange("x".repeat(110)))).toBeUndefined()
    expect(failure(withChange("x".repeat(111)))).toMatch(/Line/)
    expect(failure(withChange("  "))).toMatch(/Line/)
  })

  it("refuses what the notes' schema couldn't hold, so writing the block can't throw", () => {
    const many = Array.from({ length: maxChanges + 1 }, () => good.changes[0]!)
    expect(failure({ ...good, changes: many })).toMatch(/At most 200 changes/)
    const prs = Array.from({ length: maxPrs + 1 }, (_, index) => index + 1)
    expect(failure(withChange("Fine.", prs))).toMatch(/pull requests/)
  })

  it("refuses a pull request it was not given, or none", () => {
    expect(failure(withChange("Fine.", [999]))).toMatch(/#999/)
    expect(failure(withChange("Fine.", [195, 999]))).toMatch(/#999/)
    expect(failure(withChange("Fine.", []))).toMatch(/pull requests/)
  })

  it("refuses the whole answer when a line holds a link, markup or code", () => {
    for (const line of [
      "See [the docs](https://example.com).",
      "Open [this] now.",
      "Visit https://example.com today.",
      "Visit www.example.com today.",
      "Use <b>bold</b> text.",
      "Run `rm -rf` now.",
      "Shown as ![logo](x.png).",
      "Go to http://x.test.",
      "Make it **bold**.",
      "Cross ~~out~~ that.",
      "Escape a \\ here.",
    ])
      expect(failure(withChange(line)), line).toMatch(/holds/)
    const title = { ...good, highlights: [{ ...good.highlights[0]!, title: "<b>Bold</b>" }] }
    expect(failure(title)).toMatch(/holds/)
  })

  it("lets a terminal's word handle through", () => {
    expect(failure(withChange("Terminals are named @moth, @fox and @owl."))).toBeUndefined()
  })

  it("drops a line on an excluded topic, and says so", () => {
    for (const line of [
      "A new chat view for agents.",
      "You can chat with an agent.",
      "The demo shows real terminals.",
      "Open it at try.novadeck.dev.",
      "The website explains pins.",
      "CI runs faster.",
      "A GitHub Action is added.",
    ]) {
      const checked = checkOutput(withChange(line), allowed)
      expect(checked, line).toMatchObject({ ok: true, output: { changes: [] } })
      expect(checked.ok && checked.dropped, line).toHaveLength(1)
    }
    expect(failure(withChange("Terminals pick up a new decision."))).toBeUndefined()
  })

  it("drops a highlight on an excluded topic and keeps a promotion valid with none left", () => {
    const output = { ...good, highlights: [{ ...good.highlights[0]!, title: "Chat" }] }
    expect(checkOutput(output, allowed)).toMatchObject({
      ok: true,
      output: { highlights: [] },
      dropped: [expect.stringContaining("Chat")],
    })
  })

  it("drops a line in an area that is not ours without failing the answer", () => {
    const checked = checkOutput(withChange("Fine.", [195], "Sharing"), allowed)
    expect(checked).toMatchObject({ ok: true, output: { changes: [] } })
    expect(checked.ok && checked.dropped[0]).toContain("Sharing")
  })
})
