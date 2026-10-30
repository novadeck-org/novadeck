import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { folder } from "../testing/engines.js"
import { gitBranch } from "./branch.js"

describe("a directory's git branch", () => {
  it("is cut to 200 characters, never through an emoji", async ({ resources }) => {
    const directory = await folder(resources)
    await mkdir(join(directory, ".git"))
    const name = `${"b".repeat(199)}😀`
    await writeFile(join(directory, ".git", "HEAD"), `ref: refs/heads/${name}\n`)

    expect(await gitBranch(directory)).toBe("b".repeat(199))
  })
})
