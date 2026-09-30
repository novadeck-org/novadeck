import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { planContent, planStamp } from "./plans.js"

const it = base.extend<{ directory: string }>({
  directory: async ({ resources }, use) => {
    const directory = mkdtempSync(join(tmpdir(), "novadeck-plans-"))
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    await use(directory)
  },
})

describe("a plan's content", () => {
  it("is its file's text, and when it changed", async ({ directory }) => {
    const path = join(directory, "p.md")
    writeFileSync(path, "# Plan\n")
    await expect(planContent("r", { kind: "file", path })).resolves.toEqual({
      ref: "r",
      text: "# Plan\n",
      truncated: false,
      changedAt: expect.any(Number),
    })
    expect(await planStamp({ kind: "file", path })).toMatch(/^7:/)
  })

  it("is cut short past 256 KiB, never mid-character", async ({ directory }) => {
    const path = join(directory, "p.md")
    writeFileSync(path, `${"a".repeat(256 * 1024 - 1)}ż and more`)
    const content = await planContent("r", { kind: "file", path })
    expect(content?.truncated).toBe(true)
    expect(content?.text).toBe("a".repeat(256 * 1024 - 1))
  })

  it("is nothing while its file is not there, and a presented text as it is", async ({
    directory,
  }) => {
    const missing = { kind: "file", path: join(directory, "none.md") } as const
    await expect(planContent("r", missing)).resolves.toBeUndefined()
    await expect(planStamp(missing)).resolves.toBeUndefined()
    await expect(
      planContent("r", { kind: "text", text: "# P", truncated: false }),
    ).resolves.toEqual({
      ref: "r",
      text: "# P",
      truncated: false,
      changedAt: null,
    })
  })

  it.skipIf(process.platform === "win32")(
    "is nothing but a plain file, so a pipe in its place never blocks",
    async ({ directory }) => {
      const path = join(directory, "p.md")
      expect(spawnSync("mkfifo", [path]).status).toBe(0)
      await expect(planStamp({ kind: "file", path })).resolves.toBeUndefined()
      await expect(planContent("r", { kind: "file", path })).resolves.toBeUndefined()
    },
  )
})
