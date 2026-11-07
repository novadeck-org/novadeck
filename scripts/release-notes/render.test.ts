import { describe, expect, it } from "vitest"

import { readNotesBlock, type ReleaseNotes } from "../../contract/protocol/src/release-notes.ts"
import { releaseBody } from "./fixtures.ts"
import { fitBody, originalOf, renderBody } from "./render.ts"

const repo = "novadeck-org/novadeck"
const promote: ReleaseNotes = {
  version: "0.0.152",
  kind: "promote",
  highlights: [
    { title: "Word handles", line: "Terminals get a name like @moth.", prs: [181] },
    { title: "Plans", line: "Agent plans open beside the terminal.", prs: [188, 190] },
  ],
  changes: [
    { area: "Fixes & speedups", line: "Off-screen Canvas nodes stop laying out.", prs: [261] },
    { area: "Inbox & notifications", line: "Answer agents from the Inbox.", prs: [195] },
    { area: "Inbox & notifications", line: "Agents can ask and tell.", prs: [198] },
  ],
  fixes: 3,
}
const original = originalOf(releaseBody)

describe("a rendered body", () => {
  it("leads a promotion with highlights, then the areas in their order, then the fixes", () => {
    const body = renderBody(
      {
        ...promote,
        changes: promote.changes.filter((change) => change.area !== "Fixes & speedups"),
      },
      original,
      repo,
    )
    const at = (text: string) => body.indexOf(text)
    expect(body).toMatch(
      /^## Highlights\n\n- \*\*Word handles\*\*: Terminals get a name like `@moth`\. \(\[#181\]\(https:\/\/github\.com\/novadeck-org\/novadeck\/pull\/181\)\)/,
    )
    expect(body).toContain("[#188](https://github.com/novadeck-org/novadeck/pull/188), [#190]")
    expect(at("## Highlights")).toBeLessThan(at("## What's new"))
    expect(at("## Highlights")).toBeLessThan(at("### Inbox & notifications"))
    expect(at("## What's new")).toBeLessThan(at("## Fixes and speedups"))
    expect(body).toContain(
      "## Fixes and speedups\n\n3 smaller fixes and speedups besides the ones above.",
    )
    expect(at("## Fixes and speedups")).toBeLessThan(at("<!-- novadeck:notes"))
    expect(at("<!-- novadeck:notes")).toBeLessThan(at("<details><summary>All commits</summary>"))
  })

  it("carries the notes in its block and the release-it changelog in its details", () => {
    const body = renderBody(promote, original, repo)
    expect(readNotesBlock(body)).toEqual(promote)
    expect(body).toMatch(/<details><summary>All commits<\/summary>\n\n## \[0\.0\.152\]/)
    expect(body.trimEnd().endsWith("</details>")).toBe(true)
    expect(body).toContain("assistive technology hears who leads whom")
  })

  it("lists a release's lines by area with no highlights section", () => {
    const body = renderBody(
      { ...promote, kind: "release", highlights: [], fixes: 1 },
      original,
      repo,
    )
    expect(body).not.toContain("## Highlights")
    expect(body).not.toContain("## What's new")
    expect(body).toMatch(
      /^### Inbox & notifications\n\n- Answer agents from the Inbox\. \(\[#195\]/,
    )
    expect(body).toContain("Plus 1 smaller fix or speedup.")
  })

  it("leads a release with its highlights, and says no more when they are all it has", () => {
    const highlights = [{ title: "Teams", line: "Teams show on the rail.", prs: [328] }]
    const body = renderBody(
      { version: "0.0.1", kind: "release", highlights, changes: [], fixes: 1 },
      "",
      repo,
    )
    expect(body).toMatch(/^### Highlights\n\n- \*\*Teams\*\*: Teams show on the rail\. \(\[#328\]/)
    expect(body).toContain("Plus 1 smaller fix or speedup.")
    expect(body).not.toContain("Nothing in this build")
    expect(body).not.toMatch(/^## Highlights/m)
  })

  it("says so when a release changes nothing a person sees, and still carries the block", () => {
    const body = renderBody(
      {
        version: "0.0.1",
        kind: "release",
        highlights: [],
        changes: [],
        fixes: 0,
      },
      "",
      repo,
    )
    expect(body).toMatch(/^Nothing in this build changes what you see/)
    expect(body).toContain("<!-- novadeck:notes")
    expect(body).not.toContain("<details>")
  })

  it("writes word handles in code spans, so GitHub mentions nobody, and keeps the block raw", () => {
    const body = renderBody(promote, original, repo)
    expect(body).toContain("- **Word handles**: Terminals get a name like `@moth`.")
    expect(body).toContain("Terminals get a name like @moth.")
    expect(readNotesBlock(body)?.highlights[0]?.line).toBe("Terminals get a name like @moth.")
  })

  it("puts a link to the range above the changelog in a promotion's details", () => {
    const body = renderBody(promote, original, repo, "https://github.com/x/y/compare/v1...v2")
    expect(body).toMatch(
      /<details><summary>All commits<\/summary>\n\n\[Compare on GitHub\]\(https:\/\/github\.com\/x\/y\/compare\/v1\.\.\.v2\)\n\n## \[0\.0\.152\]/,
    )
  })

  it("words a promotion's fixes line for what is above it, and says so when nothing is", () => {
    const bare = { ...promote, highlights: [], changes: [], fixes: 3 }
    const body = renderBody(bare, "", repo)
    expect(body).toContain("## Fixes and speedups\n\n3 smaller fixes and speedups.")
    expect(body).not.toContain("besides")
    const nothing = renderBody({ ...bare, fixes: 0 }, "", repo)
    expect(nothing).toMatch(/^Nothing in this build changes what you see/)
  })

  it("takes release-it's changelog back out of a body it already rewrote", () => {
    const rewritten = renderBody(promote, original, repo)
    expect(originalOf(rewritten)).toBe(original)
    expect(originalOf(renderBody(promote, original, repo, "https://x.test/compare/a...b"))).toBe(
      original,
    )
    expect(originalOf(releaseBody)).toBe(releaseBody)
    expect(originalOf(undefined)).toBe("")
  })

  it("closes the Fixes & speedups area with the smaller fixes' count when there is one", () => {
    const body = renderBody(promote, "", repo)
    expect(body).toMatch(
      /### Fixes & speedups\n\n- Off-screen[^\n]*\n\nPlus 3 smaller fixes and speedups\.\n/,
    )
    expect(body).not.toContain("## Fixes and speedups")
    const release = renderBody({ ...promote, kind: "release", highlights: [] }, "", repo)
    expect(release).toMatch(/### Fixes & speedups[\s\S]*\n\nPlus 3 smaller fixes and speedups\.\n/)
    expect(release.match(/Plus 3 smaller/g)).toHaveLength(1)
    // Without that area the count keeps its own section.
    const without = renderBody(
      {
        ...promote,
        changes: promote.changes.filter((change) => change.area !== "Fixes & speedups"),
      },
      "",
      repo,
    )
    expect(without).toContain("## Fixes and speedups\n\n3 smaller fixes and speedups besides")
  })

  it("fits the body to the limit by cutting the changelog first, then gives up", () => {
    const big = "line of changelog\n".repeat(2_000)
    expect(fitBody(promote, big, repo, undefined, 200_000)).toBe(renderBody(promote, big, repo))
    const fitted = fitBody(promote, big, repo, undefined, 5_000)!
    expect(fitted.length).toBeLessThanOrEqual(5_000)
    expect(fitted).toContain("The rest of the changelog is cut for length.")
    expect(readNotesBlock(fitted)).toEqual(promote)
    expect(fitBody(promote, big, repo, undefined, 300)).toBeUndefined()
  })
})
