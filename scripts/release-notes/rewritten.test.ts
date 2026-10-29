import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { generatePromote, generateRelease, type Ask } from "./generate.ts"
import { history, removeHistories, type History, type Step } from "./history.ts"
import { makeGitSources, type Sources } from "./sources.ts"

// The first two commits are older than the rewrite's first change: they stay, with v0.0.1.
const steps: Step[] = [
  ["chore: init (#1)"],
  ["feat: first (#2)", "v0.0.1"],
  ["fix: second (#3)"],
  ["feat: third (#4)", "v1.1.0"],
  ["fix: fourth (#5)", "v1.1.1"],
  ["feat: fifth (#6)"],
  ["fix: sixth (#7)", "v1.1.2"],
  ["fix: seventh (#8)"],
]

/** Git for real, with a stable release and prerelease bodies for the tags that follow it. */
afterAll(removeHistories)

// Git processes are slow to start on some runners, and these tests start many.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const over = (cwd: string, stable: string | undefined): Sources => ({
  ...makeGitSources(cwd),
  stable: async () => stable,
  release: async () => ({ body: "changelog", prerelease: true }),
})

/** What the notes for `tag` asked about, and the range they read. */
const asked = async (cwd: string, tag: string, mode: "release" | "promote") => {
  const sources = over(cwd, "v1.1.0")
  const items: number[][] = []
  const ask: Ask = async (_kind, _version, given) => {
    items.push(given.flatMap((item) => item.prs))
    return {
      text: JSON.stringify({ highlights: [], changes: [] }),
      outputTokens: 1,
      model: "m",
    }
  }
  await (mode === "release"
    ? generateRelease(tag, sources, ask)
    : generatePromote(tag, sources, ask, "o/r"))
  return items
}

describe("release notes over rewritten history", () => {
  // The release after the rewrite is a new tag on the rewritten head; v1.1.2 was the last old one.
  // Each history is built once: the tests only read them. An original history never holds a
  // marker, so `marked.original` is the one to read as it was.
  const rewrite = (marked: string[]) => {
    const made = history(steps, 2)
    made.mark(...marked)
    made.after(["fix: eighth (#9)", "v1.1.3"])
    return made
  }
  let marked: History
  let partial: History
  let bare: History

  beforeAll(() => {
    marked = rewrite(["v1.1.0", "v1.1.2"])
    partial = rewrite(["v1.1.2"])
    bare = history(steps)
    bare.after(["fix: eighth (#9)", "v1.1.3"])
  })

  it("covers the same range as the original history when the stable and newest releases are marked", async () => {
    const { original, rewritten } = marked
    expect(await asked(original, "v1.1.3", "release")).toEqual([[8, 9]])
    expect(await asked(rewritten, "v1.1.3", "release")).toEqual([[8, 9]])
    expect(await asked(original, "v1.1.3", "promote")).toEqual([[5, 6, 7, 8, 9]])
    expect(await asked(rewritten, "v1.1.3", "promote")).toEqual([[5, 6, 7, 8, 9]])
  })

  it("links a promotion's range from the marker, which GitHub can compare", async () => {
    const generated = await generatePromote(
      "v1.1.3",
      over(marked.rewritten, "v1.1.0"),
      async () => ({ text: '{"highlights":[],"changes":[]}', outputTokens: 1, model: "m" }),
      "o/r",
    )
    expect(generated.compare).toBe("https://github.com/o/r/compare/release-base/v1.1.0...v1.1.3")
  })

  it("reads the notes of an ordinary history as before, with no marker around", async () => {
    const { original } = marked
    expect(await asked(original, "v1.1.3", "release")).toEqual([[8, 9]])
    expect(await asked(original, "v1.1.3", "promote")).toEqual([[5, 6, 7, 8, 9]])
  })

  it("fails loudly, rather than list history since v0.0.1, when the stable release has no marker", async () => {
    // The release's own range starts at the marker, but a stable one out of reach is no baseline.
    await expect(asked(partial.rewritten, "v1.1.3", "release")).rejects.toThrow(
      "no release-base/v1.1.0",
    )
    await expect(asked(partial.rewritten, "v1.1.3", "promote")).rejects.toThrow(
      "v1.1.0 is not among the release tags merged into v1.1.3, and has no release-base/v1.1.0 marker",
    )
  })

  it("fails loudly for a release when nothing but the new tag is merged and a stable one exists", async () => {
    await expect(asked(bare.rewritten, "v1.1.3", "release")).rejects.toThrow(
      "v1.1.0 is not among the release tags merged into v1.1.3",
    )
  })
})
