/* eslint-disable no-await-in-loop -- Each case is read in turn. */
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { commonDir } from "../checkouts/repository.js"
import type { WorktreeRecord } from "../worktrees/records.js"
import { defaultOf, gitLookups, validName } from "./lookups.js"

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
