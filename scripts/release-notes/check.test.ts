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
const check = (output: ModelOutput, kind: "release" | "promote" = "promote") =>
  checkOutput(output, kind, allowed)
const failure = (output: ModelOutput) => {
  const checked = check(output)
  return checked.ok ? undefined : checked.reason
}
const droppedFor = (output: ModelOutput) => {
  const checked = check(output)
  return checked.ok ? checked.dropped : undefined
}

describe("the checks on a model's answer", () => {
  it("passes a good one untouched", () => {
    expect(check(good)).toEqual({ ok: true, output: good, dropped: [] })
  })

  it("allows a promotion with no highlights, and refuses more than four", () => {
    expect(failure({ ...good, highlights: [] })).toBeUndefined()
    expect(failure({ ...good, highlights: Array(5).fill(good.highlights[0]) })).toMatch(/At most 4/)
  })

  it("keeps a release's first two highlights and drops the rest", () => {
    const three = {
      ...good,
      highlights: ["One", "Two", "Three"].map((title) => ({ ...good.highlights[0]!, title })),
    }
    const checked = check(three, "release")
    expect(checked).toMatchObject({ ok: true, output: { changes: good.changes } })
    if (!checked.ok) return
    expect(checked.output.highlights.map(({ title }) => title)).toEqual(["One", "Two"])
    expect(checked.dropped).toEqual(["a highlight past the 2 a release leads with"])
    // A highlight dropped for its own sake does not take one of the two places.
    const marked = {
      ...three,
      highlights: [{ ...three.highlights[0]!, title: "*x*" }, ...three.highlights.slice(1)],
    }
    const after = check(marked, "release")
    if (!after.ok) throw new Error("expected the answer to pass")
    expect(after.output.highlights.map(({ title }) => title)).toEqual(["Two", "Three"])
  })

  it("cuts a release's highlights past the schema's four to two, not failing the answer", () => {
    const five = { ...good, highlights: Array(5).fill(good.highlights[0]) }
    const checked = check(five, "release")
    if (!checked.ok) throw new Error("expected the answer to pass")
    expect(checked.output.highlights).toHaveLength(2)
    expect(checked.dropped).toHaveLength(3)
  })

  it("checks a release's highlights as a promotion's", () => {
    const wild = { ...good, highlights: [{ title: "<b>x</b>", line: "y", prs: [181] }] }
    const checked = check(wild, "release")
    expect(checked.ok ? undefined : checked.reason).toMatch(/HTML tag/)
    expect(failure({ ...good, highlights: Array(5).fill(good.highlights[0]) })).toMatch(/At most 4/)
  })

  it("drops a title over 40 characters or a line over 110, and keeps the rest", () => {
    const title = (text: string): ModelOutput => ({
      ...good,
      highlights: [{ ...good.highlights[0]!, title: text }],
    })
    expect(droppedFor(title("x".repeat(40)))).toEqual([])
    expect(droppedFor(title("x".repeat(41)))).toHaveLength(1)
    expect(droppedFor(withChange("x".repeat(110)))).toEqual([])
    expect(droppedFor(withChange("x".repeat(111)))).toHaveLength(1)
    expect(droppedFor(withChange("  "))).toHaveLength(1)
    const checked = check(title("x".repeat(41)))
    expect(checked).toMatchObject({ ok: true, output: { highlights: [], changes: good.changes } })
  })

  it("refuses more changes than the notes' schema holds, so writing the block can't throw", () => {
    const many = Array.from({ length: maxChanges + 1 }, () => good.changes[0]!)
    expect(failure({ ...good, changes: many })).toMatch(/At most 200 changes/)
  })

  it("drops a line citing none, too many or a pull request it was not given, and keeps the rest", () => {
    const many = Array.from({ length: maxPrs + 1 }, (_, index) => index + 1)
    for (const prs of [[], many, [999], [195, 999]]) {
      const checked = check(withChange("Secret words.", prs))
      expect(checked).toMatchObject({ ok: true, output: { changes: [] } })
      expect(checked.ok && checked.dropped).toHaveLength(1)
      expect(JSON.stringify(checked)).not.toContain("Secret")
    }
    expect(failure(withChange("Fine.", [195]))).toBeUndefined()
  })

  it("refuses the whole answer on a link, an image, a URL or an HTML tag", () => {
    for (const line of [
      "See [the docs](https://example.com).",
      "Shown as ![logo](x.png).",
      "Visit https://example.com today.",
      "Visit www.example.com today.",
      "Go to http://x.test.",
      "Use <b>bold</b> text.",
      "Close </div> early.",
      "Hide <!-- this -->.",
    ])
      expect(failure(withChange(line)), line).toMatch(/holds/)
    const title = { ...good, highlights: [{ ...good.highlights[0]!, title: "<b>Bold</b>" }] }
    expect(failure(title)).toMatch(/holds/)
  })

  it("drops a line with a stray markup character instead of failing the answer", () => {
    for (const line of [
      "Make it **bold**.",
      "Cross ~~out~~ that.",
      "Escape a \\ here.",
      "Run `rm` now.",
      "Open [this now.",
      "Order a > b.",
      "A < b here.",
    ]) {
      expect(droppedFor(withChange(line)), line).toEqual(["a markup character"])
    }
  })

  it("drops a line that GitHub would link or format as a heading or a list", () => {
    for (const line of [
      "Mail me@example.com about it.",
      "# Heading",
      "1. First step",
      "  12. Twelfth",
    ])
      expect(droppedFor(withChange(line)), line).toEqual(["a markup character"])
    const title = { ...good, highlights: [{ ...good.highlights[0]!, title: "# Big" }] }
    expect(droppedFor(title)).toEqual(["a markup character"])
  })

  it("drops lines about early, beta or other pre-release channels, but not a preview of an image", () => {
    for (const line of [
      "Pick the beta update channel in Preferences.",
      "Stable and early build channels are listed.",
      "Early access builds install on their own.",
      "Nightly builds install on their own.",
      "Join the canary channel.",
      "Early builds are listed in Preferences.",
      "Choose an update channel.",
      "A prerelease is offered.",
    ])
      expect(droppedFor(withChange(line)), line).toHaveLength(1)
    for (const line of [
      "Preview images open in the pane.",
      "The markdown preview updates as the file changes.",
      "Terminals that exit early now show their release code.",
    ])
      expect(droppedFor(withChange(line)), line).toEqual([])
  })

  it("drops a line or title with a bare issue number", () => {
    expect(droppedFor(withChange("Fixes the crash from #261."))).toEqual(["a markup character"])
    const title = { ...good, highlights: [{ ...good.highlights[0]!, title: "See #12" }] }
    expect(droppedFor(title)).toEqual(["a markup character"])
  })

  it("drops chats and demos in the plural too", () => {
    for (const line of ["Chats now stream.", "Two demos load faster."])
      expect(droppedFor(withChange(line)), line).toHaveLength(1)
  })

  it("lets a terminal's word handle through", () => {
    expect(failure(withChange("Terminals are named @moth, @fox and @owl."))).toBeUndefined()
  })

  it("drops a line on an excluded topic, and says which pattern, not which line", () => {
    for (const line of [
      "A new chat view for agents.",
      "You can chat with an agent.",
      "The demo shows real terminals.",
      "Open it at try.novadeck.dev.",
      "The website explains pins.",
      "CI runs faster.",
      "A GitHub Action is added.",
      "Novadeck updates itself, with stable and early build channels.",
      "Early updates arrive first.",
      "Prereleases install on their own.",
    ]) {
      const checked = check(withChange(line))
      expect(checked, line).toMatchObject({ ok: true, output: { changes: [] } })
      expect(checked.ok && checked.dropped, line).toHaveLength(1)
      expect(JSON.stringify(checked), line).not.toContain(line)
    }
    expect(failure(withChange("Terminals pick up a new decision."))).toBeUndefined()
    expect(droppedFor(withChange("An early exit no longer loses the terminal's output."))).toEqual(
      [],
    )
  })

  it("drops a highlight on an excluded topic and keeps a promotion valid with none left", () => {
    const output = { ...good, highlights: [{ ...good.highlights[0]!, title: "Chat" }] }
    expect(check(output)).toMatchObject({
      ok: true,
      output: { highlights: [] },
      dropped: [expect.stringContaining("excluded topic")],
    })
  })

  it("drops a line in an area that is not ours without failing the answer", () => {
    expect(check(withChange("Fine.", [195], "Sharing"))).toMatchObject({
      ok: true,
      output: { changes: [] },
      dropped: ["an area that is not one of ours"],
    })
  })
})
