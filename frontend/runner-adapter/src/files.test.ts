import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRunnerFiles } from "./files"
import { context, describe, expect, it } from "./test"
import { startTestRunner } from "./testing/runner"

// The checkout calls the files under test don't make.
const noCheckout = {
  sync: async () => ({ repos: [] }),
  syncSeen: async () => {},
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

  it("asks how the repositories stand, tells what was seen and updates one, by project and path", async () => {
    const asked: string[] = []
    const files = createRunnerFiles({
      folder: async () => ({ entries: [], truncated: false }),
      sync: async (input) => {
        asked.push(`sync ${input.projectId}`)
        return {
          repos: [
            {
              path: "source/api",
              name: "api",
              branch: "main",
              behind: { remote: "origin/main", count: 3, why: null, merges: [] },
              ahead: 0,
              landing: null,
              moved: 1,
              head: "abc",
            },
          ],
        }
      },
      syncSeen: async (input) => {
        asked.push(`seen ${input.projectId} ${input.path} ${input.to}`)
      },
      updateCheckout: async (input) => {
        asked.push(`update ${input.projectId} ${input.path}`)
        return { ok: false, said: "Your local changes would be overwritten." }
      },
    })
    await expect(files.sync?.("p")).resolves.toMatchObject({
      repos: [{ path: "source/api", behind: { count: 3 } }],
    })
    await files.seen?.("p", "source/api", "def")
    await expect(files.update?.("p", "source/api")).resolves.toEqual({
      ok: false,
      said: "Your local changes would be overwritten.",
    })
    expect(asked).toEqual(["sync p", "seen p source/api def", "update p source/api"])
  })

  it("tells of no repository, and sends no word of what was seen, to a runner that doesn't know them", async () => {
    const asked: string[] = []
    const files = createRunnerFiles(
      {
        folder: async () => ({ entries: [], truncated: false }),
        sync: async () => {
          asked.push("sync")
          return { repos: [] }
        },
        syncSeen: async () => {
          asked.push("seen")
        },
        updateCheckout: async (input) => {
          asked.push(`update ${"path" in input}`)
          return { ok: true }
        },
      },
      () => false,
    )
    await expect(files.sync?.("p")).resolves.toEqual({ repos: [] })
    await files.seen?.("p", "")
    await files.update?.("p")
    expect(asked).toEqual(["update false"])
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
        await expect(files.sync?.(project.id)).resolves.toEqual({ repos: [] })
        await expect(files.update?.(project.id)).resolves.toEqual({
          ok: false,
          said: "It isn't in a git repository.",
        })
      } finally {
        await runner.close()
      }
    })

    it("tells how a repository nested in the project stands against its origin, and updates it by its path", async () => {
      const runner = await startTestRunner()
      try {
        const git = (cwd: string, ...args: string[]): void => {
          execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
            cwd,
            stdio: "ignore",
          })
        }
        const directory = await realpath(await mkdtemp(join(tmpdir(), "novadeck-sync-")))
        const bare = join(directory, "origin.git")
        await mkdir(join(directory, "source"), { recursive: true })
        await mkdir(bare)
        git(bare, "init", "--bare", "-b", "main")
        const clone = join(directory, "source", "api")
        git(directory, "clone", bare, clone)
        git(clone, "checkout", "-b", "main")
        await writeFile(join(clone, "a.txt"), "a\n")
        git(clone, "add", "-A")
        git(clone, "commit", "-m", "first")
        git(clone, "push", "-u", "origin", "main")
        git(clone, "remote", "set-head", "origin", "main")
        const other = join(directory, "other")
        git(directory, "clone", bare, other)
        await writeFile(join(other, "b.txt"), "b\n")
        git(other, "add", "-A")
        git(other, "commit", "-m", "Add b (#5)")
        git(other, "push", "origin", "main")
        git(clone, "fetch", "origin")
        const project = await runner.client.projects.create({
          id: crypto.randomUUID(),
          name: "Workspace",
          cwd: join(directory, "source"),
        })
        const files = createRunnerFiles(runner.client.projects)
        const { repos } = (await files.sync?.(project.id)) ?? { repos: [] }
        expect(repos).toMatchObject([
          { path: "api", name: "api", behind: { count: 1, why: null }, ahead: 0, landing: null },
        ])
        await expect(files.update?.(project.id, "api")).resolves.toEqual({ ok: true, moved: true })
        await expect(files.sync?.(project.id)).resolves.toMatchObject({
          repos: [{ path: "api", behind: null, moved: 1 }],
        })
        await expect(files.seen?.(project.id, "api")).resolves.toBeUndefined()
      } finally {
        await runner.close()
      }
    })
  })
})
