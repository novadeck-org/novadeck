import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRunnerSource } from "./source"
import { context, describe, expect, it } from "./test"
import { startTestRunner } from "./testing/runner"

describe("the runner's source", () => {
  it("has no changes to tell of", () => {
    const source = createRunnerSource({ folder: async () => ({ entries: [], truncated: false }) })
    expect(source.state.getSnapshot()).toEqual({ projects: {} })
  })

  it("lists a folder as the runner does", async () => {
    const asked: unknown[] = []
    const listing = { entries: [{ name: "src", folder: true, ignored: false }], truncated: true }
    const source = createRunnerSource({
      folder: async (input) => {
        asked.push(input)
        return listing
      },
    })
    await expect(source.list("p", "a/b")).resolves.toEqual(listing)
    expect(asked).toEqual([{ projectId: "p", folder: "a/b" }])
  })

  it("rejects with the runner's error", async () => {
    const source = createRunnerSource({
      folder: async () => {
        throw new Error("gone")
      },
    })
    await expect(source.list("p", "")).rejects.toThrow("gone")
  })

  context("on a real runner", () => {
    it("reads the project's folders as they are, and refuses what leads out", async () => {
      const runner = await startTestRunner()
      try {
        const directory = await mkdtemp(join(tmpdir(), "novadeck-source-"))
        await mkdir(join(directory, "src"))
        await writeFile(join(directory, "src", "index.ts"), "")
        const project = await runner.client.projects.create({
          id: crypto.randomUUID(),
          name: "Source",
          cwd: directory,
        })
        const source = createRunnerSource(runner.client.projects)
        await expect(source.list(project.id, "")).resolves.toEqual({
          entries: [{ name: "src", folder: true, ignored: false }],
          truncated: false,
        })
        await expect(source.list(project.id, "src")).resolves.toMatchObject({
          entries: [{ name: "index.ts", folder: false }],
        })
        await expect(source.list(project.id, "..")).rejects.toMatchObject({
          code: "INVALID_DIRECTORY",
        })
      } finally {
        await runner.close()
      }
    })
  })
})
