import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { mainBranch, mergeTrees, snapshotCommit, snapshotTree } from "./repository.js"

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const it = base.extend<{ root: string }>({
  root: async ({ resources }, use) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-works-repo-")))
    resources.defer(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: root })
    await use(root)
  },
})

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
    cwd: root,
    encoding: "utf8",
  }).trim()

describe.skipIf(!hasGit)("git, asked about a checkout", () => {
  it("finds no main branch, and takes no snapshot, before the first commit", async ({ root }) => {
    expect(await mainBranch(root)).toBeUndefined()
    expect(await snapshotTree(root, join(root, ".git", "private"), true)).toBeUndefined()
  })

  it("snapshots the working tree in a private index, leaving the person's own", async ({
    root,
  }) => {
    writeFileSync(join(root, "a"), "1\n")
    git(root, "add", "a")
    git(root, "commit", "--quiet", "-m", "first")
    writeFileSync(join(root, "a"), "2\n")
    writeFileSync(join(root, "untracked"), "u\n")
    const staged = git(root, "status", "--porcelain")
    const index = join(root, ".git", "private-index")
    const snapshot = await snapshotTree(root, index, true)
    expect(snapshot).toBeDefined()
    expect(existsSync(index)).toBe(true)
    expect(git(root, "ls-tree", "-r", "--name-only", snapshot!.tree).split("\n")).toEqual([
      "a",
      "untracked",
    ])
    expect(git(root, "status", "--porcelain")).toBe(staged)
    // A second snapshot reuses the index and sees the files as they are then.
    rmSync(join(root, "untracked"))
    const again = await snapshotTree(root, index, false)
    expect(git(root, "ls-tree", "-r", "--name-only", again!.tree)).toBe("a")
    const commit = await snapshotCommit(root, again!.tree, again!.head)
    expect(git(root, "rev-parse", `${commit}^`)).toBe(again!.head)
    expect(git(root, "rev-parse", `${commit}^{tree}`)).toBe(again!.tree)
  })

  it("knows nothing of a merge it can't make", async ({ root }) => {
    writeFileSync(join(root, "a"), "1\n")
    git(root, "add", "a")
    git(root, "commit", "--quiet", "-m", "first")
    const head = git(root, "rev-parse", "HEAD")
    expect(await mergeTrees(root, head, head)).toMatchObject({ state: "clean" })
    expect(await mergeTrees(root, head, `${head}^{tree}`)).toEqual({ state: "unknown" })
  })
})
