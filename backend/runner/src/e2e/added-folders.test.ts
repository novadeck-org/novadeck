import { join } from "node:path"

import { hookReport } from "@novadeck/harness-core/testing/reports"
import { describe, expect, it } from "vitest"

import { harnesses } from "../harnesses/registry.js"
import { addedOutside, watchAddedFolders } from "./added-folders.js"

const home = join("/", "sandbox", "home")
const inside = join(home, ".novadeck", "worktrees")
const outside = join("/", "home", "dev", ".novadeck", "worktrees")

describe("the folders an e2e launch adds", () => {
  it("names those outside the sandbox's home only", () => {
    expect(addedOutside([`--add-dir=${inside}`], home)).toEqual([])
    expect(addedOutside([`--add-dir=${outside}`], home)).toEqual([outside])
    expect(addedOutside(["--add-dir", join(home, "..", "elsewhere")], home)).toHaveLength(1)
    // A folder beside the home whose name starts as its parent's does is still outside.
    expect(addedOutside([`--add-dir=${home}-other`], home)).toHaveLength(1)
    // A relative folder is the launch's own, within its folder.
    expect(addedOutside(["--add-dir=sub"], home)).toEqual([])
  })

  it("watches each harness's reports while it runs, and lets them go", () => {
    const original = harnesses.agy.decode
    const watching = watchAddedFolders(home)
    try {
      harnesses.agy.decode(
        hookReport("agy", "Stop", { conversationId: "c" }, { launch: [`--add-dir=${outside}`] }),
      )
      harnesses.claude.decode(
        hookReport("claude", "Stop", { session_id: "s" }, { launch: [`--add-dir=${inside}`] }),
      )
      expect(watching.outside()).toEqual([`agy was started with --add-dir ${outside}`])
    } finally {
      watching.stop()
    }
    expect(harnesses.agy.decode).toBe(original)
  })
})
