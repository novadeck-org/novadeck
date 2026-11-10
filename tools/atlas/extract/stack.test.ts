import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { roots } from "../content/areas.ts"
import type { Area } from "../src/atlas.ts"
import { createAnchors } from "./anchors.ts"
import { extractStacks } from "./stack.ts"

// It reads backend/relay and frontend/ui from the repository's root, through the atlas's
// extractors: CI sees it by those in package.json's novadeck.reads, as the reach fence
// (scripts/workspace/reach.ts) can't follow the extractors.
// oxlint-disable novadeck/reach

const repo = resolve(import.meta.dirname, "../../..")

describe("extractStacks", () => {
  // Two nested package folders, one with a Cargo.toml: enough to show the separator, and
  // quick, as each package costs a git grep per Node builtin.
  it("anchors each manifest at a posix path on every platform", () => {
    const tokens = ["backend/relay", "frontend/ui"]
    const areas = tokens.map((token) => ({ id: token }) as Area)
    const stacks = extractStacks(repo, createAnchors(repo), areas)
    expect(stacks.map((stack) => stack.manifest.file)).toEqual(
      tokens.map((token) => `${roots.find((root) => root.token === token)!.dir}/package.json`),
    )
  })
})
