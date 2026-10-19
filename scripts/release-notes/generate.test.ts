/* eslint-disable no-await-in-loop -- Each case runs on its own, one after another. */
import { describe, expect, it } from "vitest"

import { notesBlock, type ReleaseNotes } from "../../contract/protocol/src/release-notes.ts"
import { commit, commits, fakeSources, releaseBody } from "./fixtures.ts"
import { generatePromote, generateRelease, type Ask } from "./generate.ts"
import { renderBody } from "./render.ts"
import { Skip } from "./skip.ts"

const tags = ["v0.0.152", "v0.0.150", "v0.0.151", "v0.0.149", "latest", "v0.0.148"]
const answer =
  (output: object): Ask =>
  async () => ({ text: JSON.stringify(output), outputTokens: 7 })
const never: Ask = async () => {
  throw new Error("asked")
}

const released = {
  highlights: [],
  changes: [
    { area: "Look & feel", line: "The sidebar shows a team on the rail.", prs: [328] },
    { area: "Look & feel", line: "Tab descriptions say who leads whom.", prs: [330] },
  ],
}
const skipped = (run: Promise<unknown>) =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  )

describe("the notes of a prerelease", () => {
  const sources = fakeSources({
    tags,
    commits: { "v0.0.151..v0.0.152": [commit(330), commit(328), commits[5]!, commit(261)] },
    bodies: { "v0.0.152": releaseBody },
  })

  it("asks about the feat, fix and perf commits since the release before it, by version order", async () => {
    const seen: string[] = []
    const generated = await generateRelease("v0.0.152", sources, async (kind, version, items) => {
      seen.push(`${kind} ${version}: ${items.map((item) => item.prs).join(" ")}`)
      return { text: JSON.stringify(released), outputTokens: 99 }
    })
    expect(sources.ranges).toEqual(["v0.0.151..v0.0.152"])
    expect(seen).toEqual(["release 0.0.152: 330 328 261"])
    expect(generated.notes).toMatchObject({
      version: "0.0.152",
      kind: "release",
      highlights: [],
      // The perf commit is cited by no line, so it is one of the smaller fixes.
      fixes: 1,
    })
    expect(generated.outputTokens).toBe(99)
    expect(generated.original).toBe(releaseBody)
    expect(generated.compare).toBeUndefined()
  })

  it("keeps no highlight a release's answer holds", async () => {
    const generated = await generateRelease(
      "v0.0.152",
      sources,
      answer({
        highlights: [{ title: "Teams", line: "Teams show on the rail.", prs: [328] }],
        changes: released.changes,
      }),
    )
    expect(generated.notes.highlights).toEqual([])
  })

  it("skips, with the model's answer to show, when the answer is broken or fails its checks", async () => {
    for (const [ask, reason] of [
      [async () => ({ text: "not json", outputTokens: 1 }), /not JSON/],
      [answer({ highlights: [] }), /wrong shape/],
      [answer({ highlights: [], changes: [{ area: "Voice", line: "x", prs: [999] }] }), /#999/],
      [
        answer({ highlights: [], changes: [{ area: "Voice", line: "x".repeat(111), prs: [330] }] }),
        /Line/,
      ],
      [
        answer({
          highlights: [],
          changes: [{ area: "Voice", line: "See [a](http://b).", prs: [330] }],
        }),
        /holds/,
      ],
    ] as const) {
      const error = await skipped(generateRelease("v0.0.152", sources, ask))
      expect(error).toBeInstanceOf(Skip)
      expect((error as Skip).message).toMatch(reason)
      expect((error as Skip).raw).toBeTruthy()
    }
  })

  it("skips when the model throws", async () => {
    const ask: Ask = async () => {
      throw new Skip("The API answered 529: overloaded")
    }
    await expect(generateRelease("v0.0.152", sources, ask)).rejects.toThrow(/529/)
  })

  it("drops a line on an excluded topic and keeps the rest", async () => {
    const generated = await generateRelease(
      "v0.0.152",
      sources,
      answer({
        highlights: [],
        changes: [
          ...released.changes,
          { area: "Look & feel", line: "The chat view shows plans.", prs: [261] },
        ],
      }),
    )
    expect(generated.notes.changes).toHaveLength(2)
    expect(generated.dropped).toHaveLength(1)
    // The dropped line's pull request is not cited, so it counts as a smaller fix.
    expect(generated.notes.fixes).toBe(1)
  })

  it("writes a body for a model that sees nothing to announce", async () => {
    const generated = await generateRelease(
      "v0.0.152",
      sources,
      answer({ highlights: [], changes: [] }),
    )
    expect(generated.notes).toMatchObject({ changes: [], fixes: 1 })
    const quiet = fakeSources({
      tags,
      commits: { "v0.0.151..v0.0.152": [commits[5]!] },
      bodies: { "v0.0.152": releaseBody },
    })
    const none = await generateRelease("v0.0.152", quiet, never)
    expect(none.notes).toMatchObject({ changes: [], fixes: 0 })
    expect(renderBody(none.notes, none.original, "x/y")).toContain("Nothing in this build changes")
  })

  it("skips a release that is no longer a prerelease, has no release, or a promotion already wrote", async () => {
    const promoted = notesBlock({
      version: "0.0.152",
      kind: "promote",
      highlights: [],
      changes: [],
      fixes: 0,
    })
    for (const [other, reason] of [
      [
        fakeSources({
          tags,
          commits: {},
          bodies: { "v0.0.152": releaseBody },
          stables: ["v0.0.152"],
        }),
        /no longer a prerelease/,
      ],
      [fakeSources({ tags, commits: {} }), /no release/],
      [
        fakeSources({ tags, commits: {}, bodies: { "v0.0.152": `Notes\n\n${promoted}` } }),
        /promotion/,
      ],
    ] as const)
      await expect(generateRelease("v0.0.152", other, never)).rejects.toThrow(reason)
  })

  it("skips when reading the release fails", async () => {
    const broken = {
      ...sources,
      release: async () => {
        throw new Error("HTTP 502")
      },
    }
    const error = await skipped(generateRelease("v0.0.152", broken, never))
    expect(error).toBeInstanceOf(Skip)
    expect((error as Error).message).toContain("HTTP 502")
  })

  it("rewrites a build's own earlier notes from release-it's changelog, not on top of them", async () => {
    const first = await generateRelease("v0.0.152", sources, answer(released))
    const again = fakeSources({
      tags,
      commits: { "v0.0.151..v0.0.152": [commit(330), commit(328)] },
      bodies: { "v0.0.152": renderBody(first.notes, first.original, "x/y") },
    })
    expect((await generateRelease("v0.0.152", again, answer(released))).original).toBe(releaseBody)
  })

  it("fails on a usage error or git, which are not the model's to skip", async () => {
    await expect(generateRelease("main", sources, never)).rejects.toThrow(/not a vX\.Y\.Z/)
    await expect(generateRelease("v9.9.9", sources, never)).rejects.toThrow(/not among/)
  })

  it("starts at the first commit for the first release", async () => {
    const first = fakeSources({ tags: ["v0.0.1"], commits: {}, bodies: { "v0.0.1": "x" } })
    await generateRelease("v0.0.1", first, never)
    expect(first.ranges).toEqual(["..v0.0.1"])
  })
})

describe("the notes of a promotion", () => {
  const block = (notes: Partial<ReleaseNotes>): string =>
    notesBlock({
      version: "0.0.150",
      kind: "release",
      highlights: [],
      changes: [],
      fixes: 0,
      ...notes,
    })
  const body150 = `### Voice\n\n- Offer voice input in context.\n\n${block({
    changes: [{ area: "Voice", line: "Offer voice input in context.", prs: [203] }],
    fixes: 2,
  })}\n\n<details><summary>All commits</summary>\n\n## 0.0.150\n\n* addons offer\n\n</details>`
  const sources = (stable: string | undefined, own = releaseBody) =>
    fakeSources({
      tags,
      stable,
      commits: {
        "v0.0.148..v0.0.149": [commit(181)],
        "v0.0.150..v0.0.151": [commit(195)],
        "v0.0.151..v0.0.152": [commit(330)],
      },
      bodies: {
        "v0.0.149": "## 0.0.149\n\n* old changelog",
        "v0.0.150": body150,
        "v0.0.151": "## 0.0.151\n\n* inbox",
        "v0.0.152": own,
      },
    })
  const repo = "novadeck-org/novadeck"
  const picked = {
    highlights: [{ title: "Word handles", line: "Terminals get a name like @moth.", prs: [181] }],
    changes: [{ area: "Voice", line: "Offer voice input in context.", prs: [203] }],
  }

  it("reuses the lines of releases that have a block and reads the commits of those that don't", async () => {
    const source = sources("v0.0.148")
    const asked: string[] = []
    const generated = await generatePromote(
      "v0.0.152",
      source,
      async (kind, version, items) => {
        asked.push(items.map((item) => `${item.label}:${item.prs}`).join(" "))
        return { text: JSON.stringify(picked), outputTokens: 5 }
      },
      repo,
    )
    expect(asked).toEqual(["feat:181 notes:203 feat:195 feat(ui):330"])
    // v0.0.150 has a block, so its commits are never read.
    expect(source.ranges).toEqual([
      "v0.0.148..v0.0.149",
      "v0.0.150..v0.0.151",
      "v0.0.151..v0.0.152",
    ])
    // The block's two smaller fixes carry over; 195 and 330 are cited by no line.
    expect(generated.notes).toMatchObject({ kind: "promote", version: "0.0.152", fixes: 2 })
    expect(generated.notes.highlights).toHaveLength(1)
  })

  it("covers only what is newer than the stable release, and all of it when there is none", async () => {
    const after = sources("v0.0.150")
    await generatePromote("v0.0.152", after, answer({ highlights: [], changes: [] }), repo)
    expect(after.ranges).toEqual(["v0.0.150..v0.0.151", "v0.0.151..v0.0.152"])
    const all = sources(undefined)
    await generatePromote("v0.0.152", all, answer({ highlights: [], changes: [] }), repo)
    expect(all.ranges[0]).toBe("..v0.0.148")
  })

  it("keeps only its own changelog, and links the range from the stable release", async () => {
    const generated = await generatePromote("v0.0.152", sources("v0.0.148"), answer(picked), repo)
    expect(generated.original).toBe(releaseBody)
    expect(generated.original).not.toContain("## 0.0.151")
    expect(generated.compare).toBe(
      "https://github.com/novadeck-org/novadeck/compare/v0.0.148...v0.0.152",
    )
    const first = await generatePromote("v0.0.152", sources(undefined), answer(picked), repo)
    // Without a stable release there is nothing to compare from: the link is the history.
    expect(first.compare).toBe("https://github.com/novadeck-org/novadeck/commits/v0.0.152")
  })

  it("is the same on a rerun over its own body, block and details included", async () => {
    const once = await generatePromote("v0.0.152", sources("v0.0.148"), answer(picked), repo)
    const written = renderBody(once.notes, once.original, repo, once.compare)
    const twice = await generatePromote(
      "v0.0.152",
      sources("v0.0.148", written),
      answer(picked),
      repo,
    )
    expect(twice.original).toBe(releaseBody)
    expect(twice.notes.changes.map((change) => change.prs)).toEqual(
      once.notes.changes.map((change) => change.prs),
    )
    expect(renderBody(twice.notes, twice.original, repo, twice.compare)).toBe(written)
  })

  it("is valid with no highlights, whether the model gave none or the checks dropped them", async () => {
    const none = await generatePromote(
      "v0.0.152",
      sources("v0.0.148"),
      answer({ ...picked, highlights: [] }),
      repo,
    )
    expect(none.notes.highlights).toEqual([])
    const chat = {
      highlights: [{ title: "Chat view", line: "Talk to agents.", prs: [181] }],
      changes: [],
    }
    const dropped = await generatePromote("v0.0.152", sources("v0.0.148"), answer(chat), repo)
    expect(dropped.notes.highlights).toEqual([])
    expect(dropped.dropped).toHaveLength(1)
  })

  it("skips when the model fails, or gh does", async () => {
    await expect(
      generatePromote("v0.0.152", sources("v0.0.148"), answer({ highlights: [] }), repo),
    ).rejects.toBeInstanceOf(Skip)
    const noLookup = {
      ...sources("v0.0.148"),
      stable: async () => Promise.reject(new Error("HTTP 500")),
    }
    await expect(generatePromote("v0.0.152", noLookup, never, repo)).rejects.toThrow(/HTTP 500/)
    const noRelease = fakeSources({ tags, commits: {}, bodies: {} })
    await expect(generatePromote("v0.0.152", noRelease, never, repo)).rejects.toThrow(/no release/)
  })

  it("won't promote a release that is not newer than the stable one", async () => {
    await expect(generatePromote("v0.0.150", sources("v0.0.152"), never, repo)).rejects.toThrow(
      /not newer/,
    )
  })
})
