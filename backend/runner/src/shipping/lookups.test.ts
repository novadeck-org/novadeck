/* eslint-disable no-await-in-loop -- Each case is read in turn. */
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { commonDir } from "../checkouts/repository.js"
import type { WorktreeRecord } from "../worktrees/records.js"
import { defaultOf, ghRepoOf, gitLookups, validName } from "./lookups.js"

let dir: string
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e", ...args], {
    cwd,
    stdio: "pipe",
  })
const make = (name: string) => {
  const path = join(dir, name)
  sh(dir, "init", "-q", "-b", "main", path)
  sh(path, "commit", "-q", "--allow-empty", "-m", "first")
  sh(path, "branch", "feat")
  return path
}
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "own-")))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const row = async (
  path: string,
  branch: string,
  terminalId: string | null,
): Promise<WorktreeRecord> => ({
  path,
  commonDir: (await commonDir(path))!,
  branch,
  base: "x",
  projectId: "p",
  terminalId,
  adopted: false,
  branchMade: true,
  createdAt: 0,
})

describe("a branch that is the agent's own", () => {
  it("is its terminal's worktree's, in this repository: the same name elsewhere is not", async () => {
    const a = make("a")
    const b = make("b")
    const mine = await row(a, "feat", "t")
    const lookups = gitLookups("t", { ofTerminal: () => [mine], all: () => [mine] })
    expect(await lookups.own(a, "feat")).toBe(true)
    // Another repository with a branch of that name.
    expect(await lookups.own(b, "feat")).toBe(false)
    // A branch no worktree of the terminal has, and another terminal's.
    expect(await lookups.own(a, "other")).toBe(false)
    expect(await gitLookups("u", { ofTerminal: () => [], all: () => [mine] }).own(a, "feat")).toBe(
      false,
    )
  })

  it("is never a worktree's home, as its branch says or as the repository's main is", async () => {
    const a = make("a")
    sh(a, "branch", "work")
    sh(a, "config", "branch.work.novadeckHome", "feat")
    const rows = [await row(a, "feat", "t"), await row(a, "work", "t")]
    const lookups = gitLookups("t", { ofTerminal: () => rows, all: () => rows })
    // `feat` is the home `work` was told, though the terminal has a worktree on it.
    expect(await lookups.own(a, "feat")).toBe(false)
    expect(await lookups.own(a, "work")).toBe(true)
    // Another repository's home of the same name doesn't count here.
    const b = make("b")
    sh(b, "branch", "work")
    sh(b, "config", "branch.work.novadeckHome", "feat")
    const other = [await row(b, "work", "u"), await row(a, "feat", "t")]
    expect(
      await gitLookups("t", { ofTerminal: () => other, all: () => other }).own(a, "feat"),
    ).toBe(true)
  })
})

describe("the names the gate checks", () => {
  it("accepts what git does as a branch or remote, and nothing that starts a flag", async () => {
    const a = make("a")
    expect(await validName(a, "feat/x")).toBe(true)
    for (const name of ["a b", "x..y", "-f", "x\ny", "x:y", "", "a~1"])
      expect(await validName(a, name), name).toBe(false)
  })

  it("reads the default branch from origin/HEAD where it is set", async () => {
    const a = make("a")
    expect(await defaultOf(a)).toBeUndefined()
    sh(a, "remote", "add", "origin", "https://github.com/r/app.git")
    sh(a, "update-ref", "refs/remotes/origin/trunk", "HEAD")
    sh(a, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk")
    expect(await defaultOf(a)).toBe("trunk")
  })
})

describe("the repository gh acts on, from a clone's config", () => {
  const config = (...lines: string[]) => lines.join("\n")

  it("takes the only remote", () => {
    expect(ghRepoOf("remote.origin.url git@github.com:me/app.git")).toBe("me/app")
  })

  it("cannot tell with several remotes and no default", () => {
    expect(
      ghRepoOf(
        config(
          "remote.origin.url git@github.com:me/app.git",
          "remote.upstream.url https://github.com/up/app.git",
        ),
      ),
    ).toBeUndefined()
    expect(ghRepoOf("")).toBeUndefined()
  })

  it("follows gh-resolved: base is that remote's own repository, else a literal", () => {
    const two = [
      "remote.origin.url git@github.com:me/app.git",
      "remote.upstream.url https://github.com/up/app.git",
    ]
    expect(ghRepoOf(config(...two, "remote.upstream.gh-resolved base"))).toBe("up/app")
    expect(ghRepoOf(config(...two, "remote.origin.gh-resolved base"))).toBe("me/app")
    expect(ghRepoOf(config(...two, "remote.origin.gh-resolved up/app"))).toBe("up/app")
  })
})

describe("a clone's remotes, as git says them", () => {
  it("resolves gh's repository, a push's remote and a tag in a real clone", async () => {
    const path = make("fork")
    const lookups = gitLookups("t", { ofTerminal: () => [], all: () => [] })
    expect(await lookups.ghRepo(path)).toBeUndefined()
    sh(path, "remote", "add", "origin", "git@github.com:me/app.git")
    expect(await lookups.ghRepo(path)).toBe("me/app")
    sh(path, "remote", "add", "upstream", "https://github.com/up/app.git")
    expect(await lookups.ghRepo(path)).toBeUndefined()
    sh(path, "config", "remote.upstream.gh-resolved", "base")
    expect(await lookups.ghRepo(path)).toBe("up/app")
    expect(await lookups.remoteRepo(path, "origin")).toBe("me/app")
    expect(await lookups.remoteRepo(path, "upstream")).toBe("up/app")
    expect(await lookups.remoteRepo(path, "nowhere")).toBeUndefined()
    sh(path, "tag", "v1")
    expect(await lookups.tag(path, "v1")).toBe(true)
    expect(await lookups.tag(path, "feat")).toBe(false)
  })
})
