import { itemFixture } from "@novadeck/core/testing"

import { describe, expect, it } from "../test"
import { near, wrote } from "./path-field"

describe("the folders the demo's path field may suggest", () => {
  it("names those under the typed parent that start as the typed name does, in the typed form", () => {
    expect(near("~/Down", []).map(({ path }) => path)).toEqual(["~/Downloads"])
    expect(near("~/Downloads/", [])).toEqual([
      { path: "~/Downloads/storefront-assets", count: 12, more: false, open: false },
    ])
    expect(near("/tmp/", []).map(({ path }) => path)).toEqual([
      "/tmp/checkout-copy",
      "/tmp/playwright-artifacts-Xk2Lq",
      "/tmp/release-notes",
      "/tmp/render",
    ])
  })

  it("marks a folder a folder item already shows, and reads a bare tilde as the home folder", () => {
    const found = near("~", [itemFixture("render", "01", { kind: "folder", path: "~/render" })])
    expect(found.find(({ path }) => path === "~/render")?.open).toBe(true)
    expect(found.find(({ path }) => path === "~/Downloads")?.open).toBe(false)
  })

  it("leaves a dot folder out unless the typed name starts one, and names none for nothing typed", () => {
    expect(near("~/", []).map(({ path }) => path)).not.toContain("~/.cache")
    expect(near("~/.ca", []).map(({ path }) => path)).toEqual(["~/.cache"])
    expect(near("", [])).toEqual([])
  })
})

describe("the folders the demo's agents wrote in", () => {
  it("are one of each harness's, the latest first, as long ago as the clock says", () => {
    const found = wrote(1_000_000)
    expect(found.map(({ harness }) => harness)).toEqual(["Codex", "Claude Code", "Antigravity"])
    expect(found.map(({ at }) => at)).toEqual(found.map(({ at }) => at).toSorted((a, b) => b - a))
    expect(found[0]!.at).toBeLessThan(1_000_000)
  })
})
