import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { roots } from "../content/areas.ts"
import type { Area } from "../src/atlas.ts"
import { createAnchors } from "./anchors.ts"
import { extractStacks } from "./stack.ts"

const repo = resolve(import.meta.dirname, "../../..")

describe("extractStacks", () => {
  it("anchors each manifest at a posix path on every platform", () => {
    const areas = roots.map((root) => ({ id: root.token }) as Area)
    const stacks = extractStacks(repo, createAnchors(repo), areas)
    expect(stacks.length).toBeGreaterThan(0)
    for (const stack of stacks) {
      const root = roots.find((each) => each.token === stack.token)!
      expect(stack.manifest.file).toBe(`${root.dir}/package.json`)
    }
  })
})
