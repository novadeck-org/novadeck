import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { type RawCommit, whatOf } from "./commits.ts"
import {
  checkoutExperimental,
  heldFeature,
  holdBack,
  parseExperimental,
  type Experimental,
} from "./experimental.ts"
import { commit, fakeSources, releaseBody } from "./fixtures.ts"
import { generatePromote, generateRelease, type Ask } from "./generate.ts"
import { summaryOf } from "./main.ts"

const raw = (subject: string, body = ""): RawCommit => ({ sha: "abcdef0123456", subject, body })

const listed: Experimental = new Map([
  ["onboarding-tour", ["tour"]],
  ["agent-worktrees", ["worktrees", "works"]],
  ["agent-avatars", []],
])

describe("the features still behind Preferences > Experimental", () => {
  it("are the Experimental tab's rows, so a feature that leaves it is announced, and a new one is held", () => {
    const preferences = readFileSync(
      join(import.meta.dirname, "../../frontend/ui/src/preferences/Preferences.tsx"),
      "utf8",
      // A Windows checkout has CRLF endings.
    ).replaceAll("\r\n", "\n")
    const rows = /const experimentalToggles = \[(?<rows>[\s\S]*?)\n {2}\]\n/.exec(preferences)
    expect(rows).not.toBeNull()
    const ids = [...rows!.groups!["rows"]!.matchAll(/^ {6}id: "(?<id>[a-z-]+)",$/gm)].map(
      (found) => found.groups!["id"]!,
    )
    // The forges have a section of their own under the rows, in the Experimental tab's panel.
    const panel = /<TabPanel value="experimental"[\s\S]*?<\/TabPanel>/.exec(preferences)
    expect(panel).not.toBeNull()
    if (panel![0].includes(`<Section title="Forge integrations"`)) ids.push("forges")
    expect([...checkoutExperimental().keys()].toSorted()).toEqual(ids.toSorted())
  })

  it("refuses a list of the wrong shape", () => {
    expect(() => parseExperimental(`{"why": "x", "features": {"Tour": []}}`)).toThrow(/invalid_key/)
    expect(() => parseExperimental(`{"features": {"tour": []}}`)).toThrow(/"why"/)
  })
})

describe("a commit held back as Experimental", () => {
  it("is one in a listed feature's scope, alone or among others", () => {
    expect(heldFeature(raw("feat(tour): build a game (#1)"), listed)).toBe("onboarding-tour")
    expect(heldFeature(raw("fix(ui, works): a thing (#2)"), listed)).toBe("agent-worktrees")
    expect(heldFeature(raw("feat(chat): a thing (#3)"), listed)).toBeUndefined()
  })

  it("is one whose pull request names a listed feature on a line of its own", () => {
    const body =
      "## What\n\nThe Files panel lays agents' work over the files.\n\nExperimental: agent-worktrees\n"
    expect(heldFeature(raw("feat(source): lay work over files (#4)", body), listed)).toBe(
      "agent-worktrees",
    )
    // The model never reads the line: once the feature leaves, it would only say to drop it.
    expect(whatOf(body)).toBe("The Files panel lays agents' work over the files.")
    // A feature no longer listed has left Experimental: its commits are for everyone.
    expect(
      heldFeature(raw("feat(windows): two windows (#5)", "Experimental: project-windows"), listed),
    ).toBeUndefined()
    // Only a line of its own counts, not the word in a sentence.
    expect(
      heldFeature(
        raw("feat(chat): a thing (#6)", "Was it Experimental: agent-worktrees? No."),
        listed,
      ),
    ).toBeUndefined()
  })

  it("is not one whose subject alone says Experimental, which names no feature to lift it with", () => {
    for (const subject of [
      "feat(desktop): open a project in its own window, behind Experimental (#1155)",
      "feat(windows): project windows leave Experimental (#1216)",
    ])
      expect(heldFeature(raw(subject), listed)).toBeUndefined()
  })

  it("leaves the rest in their order", () => {
    const raws = [raw("feat(tour): a (#1)"), raw("fix(chat): b (#2)"), raw("feat(ui): c (#3)")]
    const { kept, held } = holdBack(raws, listed)
    expect(kept.map((each) => each.subject)).toEqual(["fix(chat): b (#2)", "feat(ui): c (#3)"])
    expect(held.map((each) => each.feature)).toEqual(["onboarding-tour"])
  })
})

describe("notes over a range with Experimental work", () => {
  const tags = ["v0.0.152", "v0.0.151", "v0.0.148"]
  const tour = raw("feat(tour): the tour builds a game (#900)")
  const leaves = raw(
    "feat(tour): the onboarding tour leaves Experimental (#901)",
    "## What\n\nEvery new person is offered the tour.",
  )
  const list = (features: Record<string, string[]>) => JSON.stringify({ why: "test", features })
  const asked =
    (seen: number[][]): Ask =>
    async (_kind, _version, items) => {
      seen.push(items.flatMap((item) => item.prs))
      return { text: JSON.stringify({ highlights: [], changes: [] }), outputTokens: 1, model: "m" }
    }

  it("leaves out a feature still listed at the tag, and says so in the run's summary", async () => {
    const sources = fakeSources({
      tags,
      stable: "v0.0.148",
      // A held test is no news, so the summary doesn't name it.
      commits: { "v0.0.148..v0.0.152": [commit(181), tour, raw("test(tour): a spec (#902)")] },
      bodies: { "v0.0.152": releaseBody },
      experimental: list({ "onboarding-tour": ["tour"] }),
    })
    const seen: number[][] = []
    const generated = await generatePromote("v0.0.152", sources, asked(seen), "o/r")
    expect(seen).toEqual([[181]])
    expect(generated.held).toEqual(["#900 (onboarding-tour)"])
    expect(summaryOf("promote", "v0.0.152", generated)).toContain(
      "Left out as still Experimental: #900 (onboarding-tour).",
    )
  })

  it("tells all of it once the tag's list lets it go, its earlier commits in the range too", async () => {
    const sources = fakeSources({
      tags,
      stable: "v0.0.148",
      commits: { "v0.0.148..v0.0.152": [commit(181), tour, leaves] },
      bodies: { "v0.0.152": releaseBody },
      experimental: list({}),
    })
    const seen: number[][] = []
    const generated = await generatePromote("v0.0.152", sources, asked(seen), "o/r")
    expect(seen).toEqual([[181, 900, 901]])
    expect(generated.held).toEqual([])
  })

  it("holds a prerelease's Experimental work back the same way", async () => {
    const sources = fakeSources({
      tags,
      commits: { "v0.0.151..v0.0.152": [tour, commit(330)] },
      bodies: { "v0.0.152": releaseBody },
      experimental: list({ "onboarding-tour": ["tour"] }),
    })
    const seen: number[][] = []
    await generateRelease("v0.0.152", sources, asked(seen))
    expect(seen).toEqual([[330]])
  })

  it("reads this checkout's list for a tag from before the list", async () => {
    const sources = fakeSources({
      tags,
      stable: "v0.0.148",
      commits: { "v0.0.148..v0.0.152": [commit(181), tour] },
      bodies: { "v0.0.152": releaseBody },
    })
    const seen: number[][] = []
    await generatePromote("v0.0.152", sources, asked(seen), "o/r")
    expect(seen).toEqual(checkoutExperimental().has("onboarding-tour") ? [[181]] : [[181, 900]])
  })
})
