/* eslint-disable no-await-in-loop -- Each case runs on its own, one after another. */
import { describe, expect, it, onTestFinished, vi } from "vitest"

import { notesBlock } from "../../contract/protocol/src/release-notes.ts"
import { maxLine } from "./check.ts"
import { commit, commits, fakeSources, releaseBody } from "./fixtures.ts"
import { generatePromote, generateRelease, type Ask } from "./generate.ts"
import { userMessage } from "./model.ts"
import { renderBody } from "./render.ts"
import { Skip } from "./skip.ts"

const tags = ["v0.0.152", "v0.0.150", "v0.0.151", "v0.0.149", "latest", "v0.0.148"]
const answer =
  (output: object): Ask =>
  async () => ({ text: JSON.stringify(output), outputTokens: 7, model: "m/test" })
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
      return { text: JSON.stringify(released), outputTokens: 99, model: "m/test" }
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
    expect(generated.model).toBe("m/test")
    expect(generated.original).toBe(releaseBody)
    expect(generated.compare).toBeUndefined()
  })

  it("keeps the highlights a release's answer holds, and the changes they shorten", async () => {
    const highlight = {
      title: "Teams",
      line: "Teams show on the rail.",
      prs: [328],
      icon: "users",
    }
    const generated = await generateRelease(
      "v0.0.152",
      sources,
      answer({ highlights: [highlight], changes: released.changes }),
    )
    expect(generated.notes.highlights).toEqual([highlight])
    expect(generated.notes.changes).toEqual(released.changes)
  })

  it("gives a highlight the generic icon when the model's is not one of ours", async () => {
    const generated = await generateRelease(
      "v0.0.152",
      sources,
      answer({
        highlights: [{ title: "Teams", line: "Teams show on the rail.", prs: [328], icon: "nope" }],
        changes: released.changes,
      }),
    )
    expect(generated.notes.highlights).toEqual([
      { title: "Teams", line: "Teams show on the rail.", prs: [328], icon: "sparkles" },
    ])
  })

  it("keeps a release's first two highlights, and every change whichever it keeps", async () => {
    const [teams, tabs] = released.changes
    const generated = await generateRelease(
      "v0.0.152",
      sources,
      answer({
        highlights: [
          { title: "Teams", line: "Teams show on the rail.", prs: [328] },
          { title: "Tabs", line: "Tabs say who leads whom.", prs: [330] },
          { title: "Teams again", line: "Teams show on the rail.", prs: [328, 330] },
        ],
        changes: released.changes,
      }),
    )
    expect(generated.notes.highlights.map(({ title }) => title)).toEqual(["Teams", "Tabs"])
    expect(generated.notes.changes).toEqual(released.changes)
    const third = await generateRelease(
      "v0.0.152",
      sources,
      answer({
        highlights: [
          { title: "Teams", line: "Teams show on the rail.", prs: [328] },
          { title: "Teams again", line: "Teams on the rail.", prs: [328] },
          { title: "Tabs", line: "Tabs say who leads whom.", prs: [330] },
        ],
        changes: [teams, tabs],
      }),
    )
    expect(third.notes.highlights.map(({ title }) => title)).toEqual(["Teams", "Teams again"])
    expect(third.notes.changes).toEqual([teams, tabs])
  })

  it("skips, with the model's answer to show, when the answer is broken or fails its checks", async () => {
    for (const [ask, reason] of [
      [async () => ({ text: "not json", outputTokens: 1, model: "m/test" }), /not JSON/],
      [answer({ highlights: [] }), /wrong shape/],
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

  it("drops a too long line and keeps the rest, saying why but not what", async () => {
    const long = "x".repeat(maxLine + 1)
    const generated = await generateRelease(
      "v0.0.152",
      sources,
      answer({
        highlights: [],
        changes: [...released.changes, { area: "Voice", line: long, prs: [261] }],
      }),
    )
    expect(generated.notes.changes).toHaveLength(2)
    expect(generated.dropped).toHaveLength(1)
    expect(generated.dropped.join()).not.toContain(long)
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
      headsUp: [],
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
  const sources = (stable: string | undefined, own = releaseBody) =>
    fakeSources({
      tags,
      stable,
      commits: {
        "v0.0.148..v0.0.152": [commit(181), commit(195), commit(330)],
        "v0.0.150..v0.0.152": [commit(195), commit(330)],
        "..v0.0.152": [commit(181), commit(195), commit(330)],
      },
      bodies: { "v0.0.152": own },
    })
  const repo = "novadeck-org/novadeck"
  const picked = {
    highlights: [{ title: "Word handles", line: "Terminals get a name like @moth.", prs: [181] }],
    changes: [{ area: "Inbox & notifications", line: "Answer agents from the Inbox.", prs: [195] }],
  }

  it("asks about every commit of the range as it is, and reads no other release's notes", async () => {
    const source = sources("v0.0.148")
    // A prerelease's body with a block of its own is never consulted: only the promoted body is read.
    const read: string[] = []
    const watched = {
      ...source,
      release: async (tag: string) => (read.push(tag), source.release(tag)),
    }
    const asked: string[] = []
    const generated = await generatePromote(
      "v0.0.152",
      watched,
      async (kind, version, items) => {
        asked.push(items.map((item) => `${item.label}:${item.prs}`).join(" "))
        return { text: JSON.stringify(picked), outputTokens: 5, model: "m/test" }
      },
      repo,
    )
    expect(asked).toEqual(["feat:181 feat:195 feat(ui):330"])
    expect(source.ranges).toEqual(["v0.0.148..v0.0.152"])
    expect(read).toEqual(["v0.0.152"])
    // 330 is cited by no line, but it is a feature, not a smaller fix.
    expect(generated.notes).toMatchObject({ kind: "promote", version: "0.0.152", fixes: 0 })
    expect(generated.notes.highlights).toHaveLength(1)
  })

  it("covers only what is newer than the stable release, or everything before one exists", async () => {
    const after = sources("v0.0.150")
    await generatePromote("v0.0.152", after, answer({ highlights: [], changes: [] }), repo)
    expect(after.ranges).toEqual(["v0.0.150..v0.0.152"])
    const all = sources(undefined)
    await generatePromote("v0.0.152", all, answer({ highlights: [], changes: [] }), repo)
    expect(all.ranges).toEqual(["..v0.0.152"])
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

describe("the heads-ups of a range", () => {
  const withHeadsUp = (pr: number) => {
    const raw = commit(pr)
    return {
      ...raw,
      body: `${raw.body}\n\n## Heads-up\n\nThe old button is gone. Use the new one.\n`,
    }
  }
  const repo = "novadeck-org/novadeck"
  const told = {
    title: "Old button gone",
    line: "Use the new button instead.",
    prs: [195],
    icon: "wrench",
  }
  const sources = (tag: string) =>
    fakeSources({
      tags,
      stable: "v0.0.148",
      stables: ["v0.0.148"],
      commits: {
        "v0.0.151..v0.0.152": [commit(181), withHeadsUp(195)],
        "v0.0.148..v0.0.152": [commit(181), withHeadsUp(195), commit(330)],
      },
      bodies: { [tag]: releaseBody },
    })
  const output = (headsUp: object[]) => ({
    highlights: [],
    headsUp,
    changes: [{ area: "Inbox & notifications", line: "Answer agents from the Inbox.", prs: [195] }],
  })

  it("hands the model the Heads-up of a pull request that has one, and keeps what it tells", async () => {
    let message = ""
    const generated = await generateRelease(
      "v0.0.152",
      sources("v0.0.152"),
      async (kind, version, items) => {
        message = userMessage(kind, version, items)
        return { text: JSON.stringify(output([told])), outputTokens: 1, model: "m" }
      },
    )
    expect(message).toContain("Heads-up: The old button is gone. Use the new one.")
    expect(message.match(/Heads-up:/g)).toHaveLength(1)
    expect(generated.notes.headsUp).toEqual([told])
  })

  it("keeps the notes and says so when both answers leave a Heads-up untold", async () => {
    for (const bad of [output([]), { highlights: [], changes: output([]).changes }]) {
      const release = await generateRelease("v0.0.152", sources("v0.0.152"), answer(bad))
      expect(release.lost).toEqual([195])
      expect(release.notes.changes).toHaveLength(1)
      const promote = await generatePromote("v0.0.152", sources("v0.0.152"), answer(bad), repo)
      expect(promote.lost).toEqual([195])
    }
  })

  it("counts a Heads-up the model rightly leaves out as lost, so the run says so", async () => {
    const experimental = fakeSources({
      tags,
      commits: {
        "v0.0.151..v0.0.152": [
          { ...withHeadsUp(195), body: "## Heads-up\n\nThe Experimental tab moved.\n" },
        ],
      },
      bodies: { "v0.0.152": releaseBody },
    })
    const generated = await generateRelease("v0.0.152", experimental, answer(output([])))
    expect(generated.lost).toEqual([195])
    expect(generated.notes.headsUp).toEqual([])
  })

  it("asks once more when an answer loses a Heads-up, and takes the answer that keeps it", async () => {
    let asked = 0
    const generated = await generateRelease("v0.0.152", sources("v0.0.152"), async () => {
      asked += 1
      const told2 = asked === 1 ? [] : [told]
      return { text: JSON.stringify(output(told2)), outputTokens: 1, model: "m" }
    })
    expect(asked).toBe(2)
    expect(generated.notes.headsUp).toEqual([told])
  })

  it("asks only once more, and not for an answer broken some other way", async () => {
    let asked = 0
    const counted =
      (text: string) =>
      async (): Promise<{ text: string; outputTokens: number; model: string }> => {
        asked += 1
        return { text, outputTokens: 1, model: "m" }
      }
    await generateRelease("v0.0.152", sources("v0.0.152"), counted(JSON.stringify(output([]))))
    expect(asked).toBe(2)
    asked = 0
    await skipped(generateRelease("v0.0.152", sources("v0.0.152"), counted("not json")))
    expect(asked).toBe(1)
  })

  it("keeps the first answer when the second tells less", async () => {
    const other = { ...told, title: "Another", prs: [181] }
    const twoSources = fakeSources({
      tags,
      commits: { "v0.0.151..v0.0.152": [withHeadsUp(181), withHeadsUp(195)] },
      bodies: { "v0.0.152": releaseBody },
    })
    const worse = {
      highlights: [],
      headsUp: [],
      changes: [{ area: "Voice", line: "A worse answer.", prs: [195] }],
    }
    let asked = 0
    const generated = await generateRelease("v0.0.152", twoSources, async () => {
      asked += 1
      return {
        text: JSON.stringify(asked === 1 ? output([other]) : worse),
        outputTokens: 1,
        model: "m",
      }
    })
    expect(asked).toBe(2)
    expect(generated.notes.headsUp).toEqual([other])
    expect(generated.lost).toEqual([195])
  })

  it("asks no more when a second ask wouldn't fit the workflow step", async () => {
    const clock = vi.spyOn(Date, "now")
    let at = 0
    clock.mockImplementation(() => at)
    onTestFinished(() => clock.mockRestore())
    let asked = 0
    const generated = await generatePromote(
      "v0.0.152",
      sources("v0.0.152"),
      async () => {
        asked += 1
        at += 240_000
        return { text: JSON.stringify(output([])), outputTokens: 1, model: "m" }
      },
      repo,
    )
    expect(asked).toBe(1)
    expect(generated.lost).toEqual([195])
  })

  it("keeps the first answer when the second ask fails", async () => {
    let asked = 0
    const generated = await generateRelease("v0.0.152", sources("v0.0.152"), async () => {
      asked += 1
      if (asked === 2) throw new Skip("The model is down")
      return { text: JSON.stringify(output([])), outputTokens: 1, model: "m" }
    })
    expect(generated.lost).toEqual([195])
    expect(generated.notes.changes).toHaveLength(1)
  })

  it("carries the heads-ups of every pull request since the last stable release in a promotion", async () => {
    const generated = await generatePromote(
      "v0.0.152",
      sources("v0.0.152"),
      answer(output([told])),
      repo,
    )
    expect(generated.notes.headsUp).toEqual([told])
    expect(generated.notes.fixes).toBe(0)
  })

  it("takes an answer without the list when no pull request has a Heads-up", async () => {
    const plain = fakeSources({
      tags,
      commits: { "v0.0.151..v0.0.152": [commit(195)] },
      bodies: { "v0.0.152": releaseBody },
    })
    const generated = await generateRelease(
      "v0.0.152",
      plain,
      answer({
        highlights: [],
        changes: released.changes.slice(0, 1).map((c) => ({ ...c, prs: [195] })),
      }),
    )
    expect(generated.notes.headsUp).toEqual([])
  })
})
