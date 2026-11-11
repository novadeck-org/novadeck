import type { ChangeFileDiff } from "@novadeck/core/items"
import { beforeEach, describe, expect, it } from "vitest"

import { loadDiff, peekDiff } from "./diff-cache"

const file = {
  path: "a.ts",
  oldPath: null,
  status: "modified" as const,
  added: 1,
  removed: 1,
  reindented: 0,
  binary: false,
  secret: false,
}
const diff: ChangeFileDiff = {
  runs: [
    {
      layers: ["uncommitted"],
      file,
      big: false,
      badName: false,
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [
            { kind: "remove", text: "export const a = 7" },
            { kind: "add", text: "export const a = 30" },
          ],
        },
      ],
      before: "export const a = 7\n",
      after: "export const a = 30\n",
    },
  ],
}

describe("a file's diff, kept", () => {
  // What stands for a session; each test has its own.
  let scope: object
  beforeEach(() => {
    scope = {}
  })

  it("is read once for the same item, stamp, layers and path, and its facts come with it", async () => {
    let reads = 0
    const read = () => {
      reads += 1
      return Promise.resolve(diff)
    }
    const first = await loadDiff(scope, "item", "s1", ["uncommitted"], "a.ts", read)
    const second = await loadDiff(scope, "item", "s1", ["uncommitted"], "a.ts", read)

    expect(reads).toBe(1)
    expect(second).toBe(first)
    expect(first.facts[0]?.changes[0]?.edit).toEqual({ from: "7", to: "30" })
    expect(peekDiff(scope, "item", "s1", ["uncommitted"], "a.ts")).toBe(first)
  })

  it("is asked again for another stamp, another selection or another path", async () => {
    let reads = 0
    const read = () => {
      reads += 1
      return Promise.resolve(diff)
    }
    await loadDiff(scope, "item", "s1", ["uncommitted"], "a.ts", read)
    await loadDiff(scope, "item", "s2", ["uncommitted"], "a.ts", read)
    await loadDiff(scope, "item", "s1", ["uncommitted", "c1"], "a.ts", read)
    await loadDiff(scope, "item", "s1", ["uncommitted"], "b.ts", read)
    await loadDiff(scope, "other", "s1", ["uncommitted"], "a.ts", read)
    expect(reads).toBe(5)
    expect(peekDiff(scope, "item", "s3", ["uncommitted"], "a.ts")).toBeUndefined()
  })

  it("shares one question asked twice at once", async () => {
    let reads = 0
    const read = () => {
      reads += 1
      return Promise.resolve(diff)
    }
    const [a, b] = await Promise.all([
      loadDiff(scope, "item", "s1", ["c1"], "a.ts", read),
      loadDiff(scope, "item", "s1", ["c1"], "a.ts", read),
    ])
    expect(reads).toBe(1)
    expect(a).toBe(b)
  })

  it("does not keep a failure, so the next ask reads again", async () => {
    await expect(
      loadDiff(scope, "item", "s1", ["c1"], "a.ts", () => Promise.reject(new Error("gone"))),
    ).rejects.toThrow("gone")
    const loaded = await loadDiff(scope, "item", "s1", ["c1"], "a.ts", () => Promise.resolve(diff))
    expect(loaded.diff).toBe(diff)
  })

  it("has no facts for a run whose diff was past the bounds", async () => {
    const big = { runs: [{ ...diff.runs[0]!, big: true, hunks: [], before: null, after: null }] }
    const loaded = await loadDiff(scope, "item", "s1", ["c1"], "a.ts", () => Promise.resolve(big))
    expect(loaded.facts).toEqual([null])
  })

  it("lets go of the answer at an older stamp once the same question is answered at a new one", async () => {
    await loadDiff(scope, "i", "1", ["uncommitted"], "a.ts", async () => diff)
    await loadDiff(scope, "i", "2", ["uncommitted"], "a.ts", async () => diff)
    expect(peekDiff(scope, "i", "1", ["uncommitted"], "a.ts")).toBeUndefined()
    expect(peekDiff(scope, "i", "2", ["uncommitted"], "a.ts")).toBeDefined()
  })

  it("does not keep the text of a declaration", async () => {
    const loaded = await loadDiff(scope, "i", "1", ["uncommitted"], "a.ts", async () => diff)
    const all = loaded.facts[0]!.declarations
    expect([...all.added, ...all.removed, ...all.changed].every((each) => each.body === "")).toBe(
      true,
    )
  })
})
