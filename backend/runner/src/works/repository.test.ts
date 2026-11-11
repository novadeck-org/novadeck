import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
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
import {
  mainBranch,
  mergeTrees,
  repack,
  snapshotCommit,
  snapshotTree,
  treeGone,
} from "./repository.js"

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
  it("finds no main branch, and a snapshot with no commit under it, before the first commit", async ({
    root,
  }) => {
    writeFileSync(join(root, "a"), "1\n")
    expect(await mainBranch(root)).toBeUndefined()
    const taken = await snapshotTree(root, join(root, ".git", "private"))
    expect(taken?.head).toBe("")
    expect(git(root, "ls-tree", "-r", "--name-only", taken!.tree)).toBe("a")
  })

  const objectsIn = (root: string): number => {
    const counted = git(root, "count-objects", "-v")
    return (
      Number(/^count: (\d+)/m.exec(counted)![1]) + Number(/^in-pack: (\d+)/m.exec(counted)![1]!)
    )
  }

  it("writes what it hashes to a folder of its own, never to the person's objects", async ({
    root,
  }) => {
    writeFileSync(join(root, "a"), "1\n")
    git(root, "add", "a")
    git(root, "commit", "--quiet", "-m", "first")
    writeFileSync(join(root, "a"), "2\n")
    writeFileSync(join(root, "new.txt"), "brand new\n")
    const before = objectsIn(root)
    const objects = join(root, ".git", "private-objects")
    const taken = await snapshotTree(root, join(root, ".git", "private-index"), objects)

    expect(objectsIn(root)).toBe(before)
    expect(existsSync(objects)).toBe(true)
    // What it made is still found by the runs that read it.
    const read = await snapshotCommit(root, taken!.tree, taken!.head, taken!.env)
    expect(read).toBeDefined()
    expect(await treeGone(root, taken!.tree, taken!.env)).toBe(false)
    expect(await treeGone(root, taken!.tree)).toBe(true)
  })

  it("never hashes a file that may hold secrets", async ({ root }) => {
    writeFileSync(join(root, "a"), "1\n")
    git(root, "add", "a")
    git(root, "commit", "--quiet", "-m", "first")
    writeFileSync(join(root, ".env"), "TOKEN=SECRET_VALUE_XYZ\n")
    writeFileSync(join(root, "id_rsa"), "SECRET_KEY_XYZ\n")
    const taken = await snapshotTree(
      root,
      join(root, ".git", "private-index"),
      join(root, ".git", "po"),
    )
    expect(git(root, "ls-tree", "-r", "--name-only", taken!.tree).split("\n")).toEqual(["a"])
    // Only named, for a listing to show.
    expect([...taken!.secret].toSorted()).toEqual([".env", "id_rsa"])
    const blob = git(root, "hash-object", ".env")
    const found = (() => {
      try {
        execFileSync("git", ["cat-file", "-e", blob], { cwd: root, stdio: "ignore" })
        return true
      } catch {
        return false
      }
    })()
    expect(found).toBe(false)
  })

  it("judges untracked files by the environment it is given", async ({ root }) => {
    writeFileSync(join(root, "a"), "1\n")
    git(root, "add", "a")
    git(root, "commit", "--quiet", "-m", "first")
    writeFileSync(join(root, "login.json"), "{}\n")
    const index = join(root, ".git", "private-index")
    const plain = await snapshotTree(root, index, join(root, ".git", "po"), {})
    expect(plain!.secret).toEqual([])
    const moved = await snapshotTree(root, index, join(root, ".git", "po"), {
      NETRC: join(root, "login.json"),
    })
    expect(moved!.secret).toEqual(["login.json"])
  })

  it("reads a repository whose path holds the alternates separator", async ({ root }) => {
    const odd = join(root, process.platform === "win32" ? "se;mi" : "co:lon")
    mkdirSync(odd)
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: odd })
    writeFileSync(join(odd, "a"), "1\n")
    git(odd, "add", "a")
    git(odd, "commit", "--quiet", "-m", "first")
    writeFileSync(join(odd, "a"), "2\n")
    const taken = await snapshotTree(odd, join(odd, ".git", "pi"), join(odd, ".git", "po"))

    expect(taken).toBeDefined()
    expect(await treeGone(odd, taken!.tree, taken!.env)).toBe(false)
    const read = execFileSync("git", ["cat-file", "blob", `${taken!.tree}:a`], {
      cwd: odd,
      encoding: "utf8",
      env: { ...process.env, ...taken!.env },
    })
    expect(read).toBe("2\n")
    // A file the snapshot did not touch is read from the repository's own objects.
    expect(
      execFileSync("git", ["cat-file", "blob", "HEAD:a"], {
        cwd: odd,
        encoding: "utf8",
        env: { ...process.env, ...taken!.env },
      }),
    ).toBe("1\n")
  })

  it("rebuilds an object folder to what the trees it is told reach, and nothing else", async ({
    root,
  }) => {
    writeFileSync(join(root, "a"), "1\n")
    git(root, "add", "a")
    git(root, "commit", "--quiet", "-m", "first")
    const objects = join(root, ".git", "po")
    const index = join(root, ".git", "pi")
    writeFileSync(join(root, "a"), "kept\n")
    const kept = await snapshotTree(root, index, objects)
    writeFileSync(join(root, "a"), "dropped\n")
    const dropped = await snapshotTree(root, index, objects)

    expect(await repack(root, objects, [kept!.tree])).toBe(true)

    expect(await treeGone(root, kept!.tree, kept!.env)).toBe(false)
    const blob = (tree: string) =>
      execFileSync("git", ["cat-file", "blob", `${tree}:a`], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, ...kept!.env },
      })
    expect(blob(kept!.tree)).toBe("kept\n")
    expect(await treeGone(root, dropped!.tree, kept!.env)).toBe(true)
    expect(existsSync(`${objects}.new`)).toBe(false)
    expect(existsSync(`${objects}.old`)).toBe(false)
  })

  it("takes no untracked file where status shows none", async ({ root }) => {
    writeFileSync(join(root, "a"), "1\n")
    git(root, "add", "a")
    git(root, "commit", "--quiet", "-m", "first")
    git(root, "config", "status.showUntrackedFiles", "no")
    writeFileSync(join(root, "dotfile"), "x\n")
    const taken = await snapshotTree(root, join(root, ".git", "private-index"))
    expect(git(root, "ls-tree", "-r", "--name-only", taken!.tree)).toBe("a")
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
