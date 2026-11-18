import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRunnerFiles } from "./files"
import { context, describe, expect, it } from "./test"
import { startTestRunner } from "./testing/runner"

// The checkout calls the files under test don't make.
const noCheckout = {
  checkout: async () => ({ behind: null, moved: 0, head: null }),
  updateCheckout: async () => ({ ok: true as const }),
}

describe("the runner's files", () => {
  it("has no changes to tell of", () => {
    const files = createRunnerFiles({
      ...noCheckout,
      folder: async () => ({ entries: [], truncated: false }),
    })
    expect(files.state.getSnapshot()).toEqual({ projects: {} })
  })

  it("lists a folder as the runner does", async () => {
    const asked: unknown[] = []
    const listing = { entries: [{ name: "src", folder: true, ignored: false }], truncated: true }
    const files = createRunnerFiles({
      ...noCheckout,
      folder: async (input) => {
        asked.push(input)
        return listing
      },
    })
    await expect(files.list("p", "a/b")).resolves.toEqual(listing)
    expect(asked).toEqual([{ projectId: "p", folder: "a/b" }])
  })

  it("rejects with the runner's error", async () => {
    const files = createRunnerFiles({
      ...noCheckout,
      folder: async () => {
        throw new Error("gone")
      },
    })
    await expect(files.list("p", "")).rejects.toThrow("gone")
  })

  it("asks how the checkout stands and updates it, by project", async () => {
    const asked: string[] = []
    const files = createRunnerFiles({
      folder: async () => ({ entries: [], truncated: false }),
      checkout: async (input) => {
        asked.push(`checkout ${input.projectId}`)
        return {
          behind: { branch: "main", remote: "origin/main", count: 3 },
          moved: 1,
          head: "abc",
        }
      },
      updateCheckout: async (input) => {
        asked.push(`update ${input.projectId}`)
        return { ok: false, said: "Your local changes would be overwritten." }
      },
    })
    await expect(files.checkout?.("p")).resolves.toMatchObject({ behind: { count: 3 } })
    await expect(files.update?.("p")).resolves.toEqual({
      ok: false,
      said: "Your local changes would be overwritten.",
    })
    expect(asked).toEqual(["checkout p", "update p"])
  })

  context("on a real runner", () => {
    it("reads the project's folders as they are, and refuses what leads out", async () => {
      const runner = await startTestRunner()
      try {
        const directory = await mkdtemp(join(tmpdir(), "novadeck-files-"))
        await mkdir(join(directory, "src"))
        await writeFile(join(directory, "src", "index.ts"), "")
        const project = await runner.client.projects.create({
          id: crypto.randomUUID(),
          name: "Storefront",
          cwd: directory,
        })
        const files = createRunnerFiles(runner.client.projects)
        await expect(files.list(project.id, "")).resolves.toEqual({
          entries: [{ name: "src", folder: true, ignored: false }],
          truncated: false,
        })
        await expect(files.list(project.id, "src")).resolves.toMatchObject({
          entries: [{ name: "index.ts", folder: false }],
        })
        await expect(files.list(project.id, "..")).rejects.toMatchObject({
          code: "INVALID_DIRECTORY",
        })
        await expect(files.checkout?.(project.id)).resolves.toEqual({
          behind: null,
          moved: 0,
          head: null,
        })
      } finally {
        await runner.close()
      }
    })
  })
})
