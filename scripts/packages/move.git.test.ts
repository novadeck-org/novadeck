import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { carry, dirt, ignoredPlaces, outsideWorkspace, undoneByMerge } from "./move.ts"

// Each test builds throwaway git repositories, and git is slow to start on Windows: these
// files' tests may take a minute, beside the default 5 s every other test keeps.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// A move's parts that read a repository, each over a throwaway one.

const made: string[] = []
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "move-test-"))
  made.push(root)
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  const write = (file: string, text = file) => {
    mkdirSync(join(root, dirname(file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  git("init", "-q", "-b", "main")
  return { root, git, write }
}

/** A symbolic link at `path` to `../elsewhere`, and its target as read; none where not allowed. */
const linked = (path: string): string | undefined => {
  try {
    symlinkSync("../elsewhere", path)
  } catch {
    return undefined
  }
  return readlinkSync(path)
}

const to = (file: string) =>
  file.startsWith("old/") ? `new/${file.slice("old/".length)}` : undefined

describe("what keeps a tree from counting as clean", () => {
  it("is every change but a file git doesn't track at an old place", () => {
    const { root, git, write } = repo()
    write("keep.txt")
    git("add", "-A")
    git("commit", "-qm", "base")
    write("old/.env", "SECRET=1")
    expect(dirt(root, ["old"])).toEqual([])
    write("elsewhere.txt")
    write("keep.txt", "changed")
    expect(dirt(root, ["old"])).toEqual([" M keep.txt", "?? elsewhere.txt"])
  })
})

describe("build output that a package ignores", () => {
  it("is found at the place its package's .gitignore names, before or after it moves", () => {
    const { root, write } = repo()
    write("old/.gitignore", "src/generated/\n")
    write("new/.gitignore", "src/generated/\n")
    expect(
      ignoredPlaces(root, ["old/src/generated/a.json", "new/src/generated/a.json", "old/src/a.ts"]),
    ).toEqual(["old/src/generated/a.json", "new/src/generated/a.json"])
    expect(ignoredPlaces(root, [])).toEqual([])
  })
})

describe("the workspace's globs", () => {
  it("name the places none of them takes in", () => {
    const { root, write } = repo()
    write("pnpm-workspace.yaml", "packages:\n  - backend/*\n  - 'tools/*'\n  - atlas\n")
    expect(
      outsideWorkspace(root, ["backend/runner", "tools/atlas", "contract/protocol", "atlas"]),
    ).toEqual(["contract/protocol"])
  })
})

describe("what is left at an old place", () => {
  it("goes to the new place, an install's folder is dropped, and a clash stays", () => {
    const { root, git, write } = repo()
    write("new/package.json", "{}")
    write("new/.env", "OTHER=1")
    git("add", "-A")
    git("commit", "-qm", "base")
    write("old/.env", "SECRET=1")
    write("old/src/generated/a.json", "{}")
    write("old/node_modules/x/index.js")
    write("old/dist/cli.js")
    write("old/same.txt", "same")
    write("new/same.txt", "same")
    // A link, where the system lets the test make one (Windows may not); its target as the
    // system wrote it, which on Windows takes backslashes, is the target it keeps.
    const target = linked(join(root, "old/link"))
    const { carried, clashes } = carry(root, ["old"], to)
    expect(carried.map(({ to: place }) => place).toSorted()).toEqual([
      ...(target === undefined ? [] : ["new/link"]),
      "new/src/generated/a.json",
    ])
    expect(clashes).toEqual(["old/.env (new/.env holds another)"])
    expect(target && readlinkSync(join(root, "new/link"))).toBe(target)
    expect(existsSync(join(root, "new/dist/cli.js"))).toBe(true)
    expect(existsSync(join(root, "new/node_modules"))).toBe(false)
    // What stands at the old place is the clash alone.
    expect(readFileSync(join(root, "old/.env"), "utf8")).toBe("SECRET=1")
    expect(existsSync(join(root, "old/node_modules"))).toBe(false)
    expect(existsSync(join(root, "old/same.txt"))).toBe(false)
  })

  it("leaves a folder that still holds a tracked file", () => {
    const { root, git, write } = repo()
    write("old/a.ts")
    git("add", "-A")
    git("commit", "-qm", "base")
    write("old/.env")
    expect(carry(root, ["old"], to)).toEqual({ carried: [], clashes: [] })
    expect(existsSync(join(root, "old/.env"))).toBe(true)
  })
})

describe("a rename or a deletion on a branch that main's move undid", () => {
  // The branch renamed old/a.ts and deleted old/b.ts; main moved old/ to new/. The merge's
  // tree keeps main's a.ts and b.ts beside the branch's c.ts, as git leaves the conflicts.
  const merged = () => {
    const r = repo()
    const { git, write } = r
    write("old/package.json", "{}")
    write("old/a.ts", "a\n".repeat(20))
    write("old/b.ts", "b\n".repeat(20))
    git("add", "-A")
    git("commit", "-qm", "base")
    git("checkout", "-qb", "branch")
    git("mv", "old/a.ts", "old/c.ts")
    git("rm", "-q", "old/b.ts")
    git("commit", "-qm", "branch work")
    git("checkout", "-q", "main")
    git("mv", "old", "new")
    git("commit", "-qm", "the move")
    git("checkout", "-q", "branch")
    git("merge", "-q", "-s", "ours", "--no-commit", "main")
    git("rm", "-rq", "old")
    write("new/package.json", "{}")
    write("new/a.ts", "a\n".repeat(20))
    write("new/b.ts", "b\n".repeat(20))
    write("new/c.ts", "a\n".repeat(20))
    git("add", "-A")
    git("commit", "-qm", "merge main")
    return r
  }
  const options = (root: string) => ({
    root,
    marker: { from: "old/package.json", to: "new/package.json" },
    olds: ["old"],
    destinationOf: to,
  })

  it("names each file main's side brought back, while the branch's change stands beside it", () => {
    const { root } = merged()
    const found = undoneByMerge(options(root)).toSorted((x, y) => x.back.localeCompare(y.back))
    expect(found).toEqual([
      { back: "new/a.ts", file: "old/a.ts", renamed: "new/c.ts" },
      { back: "new/b.ts", file: "old/b.ts" },
    ])
  })

  it("lets a rename through once one copy is gone, and anything once a commit settles it", () => {
    const { root, git } = merged()
    git("rm", "-q", "new/c.ts")
    git("commit", "-q", "--amend", "--no-edit")
    expect(undoneByMerge(options(root))).toEqual([{ back: "new/b.ts", file: "old/b.ts" }])
    git("commit", "-q", "--allow-empty", "-m", "keep main's b.ts")
    expect(undoneByMerge(options(root))).toEqual([])
  })
})
