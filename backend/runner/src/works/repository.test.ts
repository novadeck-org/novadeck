import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { mainBranch, mergeTrees, snapshotCommit, snapshotTree, treeGone } from "./repository.js"

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
    expect(await snapshotTree(root, join(root, ".git", "private"))).toBeUndefined()
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
    const snapshot = await snapshotTree(root, index)
    expect(snapshot).toBeDefined()
    expect(existsSync(index)).toBe(true)
    expect(git(root, "ls-tree", "-r", "--name-only", snapshot!.tree).split("\n")).toEqual([
      "a",
      "untracked",
    ])
    expect(git(root, "status", "--porcelain")).toBe(staged)
    // A second snapshot sees the files as they are then.
    rmSync(join(root, "untracked"))
    const again = await snapshotTree(root, index)
    expect(git(root, "ls-tree", "-r", "--name-only", again!.tree)).toBe("a")
    const commit = await snapshotCommit(root, again!.tree, again!.head)
    expect(git(root, "rev-parse", `${commit}^`)).toBe(again!.head)
    expect(git(root, "rev-parse", `${commit}^{tree}`)).toBe(again!.tree)
  })

  it("leaves out a file that became ignored, and untracked files over 1 MiB, saying so", async ({
    root,
  }) => {
    writeFileSync(join(root, "a"), "1\n")
    git(root, "add", "a")
    git(root, "commit", "--quiet", "-m", "first")
    writeFileSync(join(root, "gone.log"), "x\n")
    writeFileSync(join(root, "big.bin"), Buffer.alloc(1024 * 1024 + 1))
    writeFileSync(join(root, "ok.bin"), Buffer.alloc(1024 * 1024))
    const index = join(root, ".git", "private-index")
    const before = await snapshotTree(root, index)
    expect(git(root, "ls-tree", "-r", "--name-only", before!.tree).split("\n")).toEqual([
      "a",
      "gone.log",
      "ok.bin",
    ])
    expect(before!.skipped).toBe(true)
    writeFileSync(join(root, ".git", "info", "exclude"), "*.log\n")
    const after = await snapshotTree(root, index)
    expect(git(root, "ls-tree", "-r", "--name-only", after!.tree).split("\n")).toEqual([
      "a",
      "ok.bin",
    ])
  })

  it("builds the snapshot from a copy of the person's index, which stays as it was", async ({
    root,
  }) => {
    writeFileSync(join(root, "a"), "1\n")
    git(root, "add", "a")
    git(root, "commit", "--quiet", "-m", "first")
    writeFileSync(join(root, "a"), "2\n")
    git(root, "add", "a")
    writeFileSync(join(root, "a"), "3\n")
    const person = readFileSync(join(root, ".git", "index"))
    const snapshot = await snapshotTree(root, join(root, ".git", "private-index"))
    expect(git(root, "show", `${snapshot!.tree}:a`)).toBe("3")
    expect(readFileSync(join(root, ".git", "index")).equals(person)).toBe(true)
  })

  it("sees a file rewritten at the same size in the moment the person's index was written", async ({
    root,
  }) => {
    writeFileSync(join(root, "a"), "1\n")
    git(root, "add", "a")
    git(root, "commit", "--quiet", "-m", "first")
    // The file and the index share one moment, as when an agent writes right after a `git
    // add`: the index's entry can't vouch for a later write in that moment.
    const moment = new Date(Math.floor(Date.now() / 1_000) * 1_000 - 60_000)
    utimesSync(join(root, "a"), moment, moment)
    git(root, "add", "a")
    utimesSync(join(root, ".git", "index"), moment, moment)
    writeFileSync(join(root, "a"), "2\n")
    utimesSync(join(root, "a"), moment, moment)
    const snapshot = await snapshotTree(root, join(root, ".git", "private-index"))
    expect(git(root, "show", `${snapshot!.tree}:a`)).toBe("2")
  })

  it("starts from HEAD where the person has no index, and skips a file it can't read", async ({
    root,
  }) => {
    writeFileSync(join(root, "a"), "1\n")
    git(root, "add", "a")
    git(root, "commit", "--quiet", "-m", "first")
    rmSync(join(root, ".git", "index"))
    writeFileSync(join(root, "locked"), "secret\n", { mode: 0o000 })
    writeFileSync(join(root, "fine"), "f\n")
    const snapshot = await snapshotTree(root, join(root, ".git", "private-index"))
    const names = git(root, "ls-tree", "-r", "--name-only", snapshot!.tree).split("\n")
    expect(names).toContain("a")
    expect(names).toContain("fine")
    // Root can read it anyway, and Windows has no mode to make it unreadable; elsewhere it
    // is left out and the rest is still taken.
    if (process.platform !== "win32" && process.getuid?.() !== 0)
      expect(names).not.toContain("locked")
  })

  it("starts from HEAD when the repository splits its index", async ({ root }) => {
    writeFileSync(join(root, "a"), "1\n")
    git(root, "add", "a")
    git(root, "commit", "--quiet", "-m", "first")
    git(root, "config", "core.splitIndex", "true")
    writeFileSync(join(root, "b"), "b\n")
    git(root, "add", "b")
    writeFileSync(join(root, "c"), "c\n")
    git(root, "add", "c")
    const snapshot = await snapshotTree(root, join(root, ".git", "private-index"))
    expect(git(root, "ls-tree", "-r", "--name-only", snapshot!.tree).split("\n")).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("says a tree is gone only when git has no such object", async ({ root }) => {
    writeFileSync(join(root, "a"), "1\n")
    git(root, "add", "a")
    git(root, "commit", "--quiet", "-m", "first")
    expect(await treeGone(root, git(root, "rev-parse", "HEAD^{tree}"))).toBe(false)
    expect(await treeGone(root, "1".repeat(40))).toBe(true)
    expect(await treeGone(join(root, "missing"), "1".repeat(40))).toBe(false)
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
