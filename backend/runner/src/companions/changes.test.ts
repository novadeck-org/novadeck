import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { devNull, tmpdir } from "node:os"
import { join } from "node:path"

import { maxChangedFiles, maxChangesBytes, type ChangedFile } from "@novadeck/protocol"

import { describe, expect, it as base } from "../test.js"
import {
  bounded,
  changesContent,
  describeChange,
  parseDiff,
  readChange,
  repositoryOf,
} from "./changes.js"

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

type Repo = {
  readonly root: string
  readonly git: (...args: string[]) => string
  readonly write: (path: string, text: string | Buffer) => void
}

// A repository of its own in a temporary folder, with an identity and no global config.
const it = base.extend<{ repo: Repo }>({
  repo: async ({ resources }, use) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-changes-")))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=T",
          "-c",
          "user.email=t@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: devNull } },
      )
    git("init", "--quiet")
    const write = (path: string, text: string | Buffer) => {
      const full = join(root, path)
      mkdirSync(join(full, ".."), { recursive: true })
      writeFileSync(full, text)
    }
    await use({ root, git, write })
  },
})

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  oldPath: null,
  status: "modified",
  added: 0,
  removed: 0,
  binary: false,
  held: false,
  listed: false,
  hunks: [],
  ...over,
})

describe("a unified diff, parsed", () => {
  it("reads hunks of context, added and removed lines, with their counts", () => {
    const [parsed] = parseDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1..2 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@ function f() {",
        " keep",
        "-old",
        "+new",
        " tail",
        "",
      ].join("\n"),
    )
    expect(parsed).toMatchObject({ path: "src/a.ts", status: "modified", added: 1, removed: 1 })
    expect(parsed?.hunks).toEqual([
      {
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 3,
        lines: [
          { kind: "context", text: "keep" },
          { kind: "remove", text: "old" },
          { kind: "add", text: "new" },
          { kind: "context", text: "tail" },
        ],
      },
    ])
  })

  it("keeps a removed line that looks like a header, and drops the no-newline marker", () => {
    const [parsed] = parseDiff(
      [
        "diff --git a/x b/x",
        "--- a/x",
        "+++ b/x",
        "@@ -1,2 +1 @@",
        "--- a/not-a-header",
        "-b",
        "\\ No newline at end of file",
        "+c",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    )
    expect(parsed?.hunks[0]?.lines).toEqual([
      { kind: "remove", text: "-- a/not-a-header" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "c" },
    ])
    expect(parsed).toMatchObject({ added: 1, removed: 2 })
  })

  it("tells added, deleted, renamed and binary files, and quoted names", () => {
    const files = parseDiff(
      [
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1 @@",
        "+hi",
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
        "diff --git a/from name.txt b/to name.txt",
        "similarity index 90%",
        "rename from from name.txt",
        "rename to to name.txt",
        "diff --git a/img.png b/img.png",
        "Binary files a/img.png and b/img.png differ",
        'diff --git "a/tab\\tname" "b/tab\\tname"',
        "old mode 100644",
        "new mode 100755",
        "",
      ].join("\n"),
    )
    expect(
      files.map(({ path, status, oldPath, binary }) => ({ path, status, oldPath, binary })),
    ).toEqual([
      { path: "new.txt", status: "added", oldPath: null, binary: false },
      { path: "gone.txt", status: "deleted", oldPath: null, binary: false },
      { path: "to name.txt", status: "renamed", oldPath: "from name.txt", binary: false },
      { path: "img.png", status: "modified", oldPath: null, binary: true },
      { path: "tab\tname", status: "modified", oldPath: null, binary: false },
    ])
    expect(files[2]?.hunks).toEqual([])
  })
})

describe("the bounds of a change", () => {
  const lines = (count: number, width: number) => [
    {
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: count,
      lines: Array.from({ length: count }, () => ({
        kind: "add" as const,
        text: "x".repeat(width),
      })),
    },
  ]

  it("lists the files past the diff text budget, by name and counts, and says so", () => {
    const big = file("big.txt", { added: 600, hunks: lines(600, 4000) })
    const small = file("small.txt", { added: 1, hunks: lines(1, 3) })
    const { files, truncated } = bounded([big, big, small], "/r")
    expect(truncated).toBe(true)
    expect(files[0]?.hunks.length).toBe(1)
    expect(files[1]).toMatchObject({ listed: true, hunks: [], added: 600 })
    // Later files that fit still show.
    expect(files[2]?.hunks.length).toBe(1)
    const text = files.flatMap((each) => each.hunks.flatMap((hunk) => hunk.lines))
    expect(text.reduce((sum, line) => sum + line.text.length, 0)).toBeLessThanOrEqual(
      maxChangesBytes,
    )
  })

  it("keeps at most the protocol's number of files", () => {
    const many = Array.from({ length: maxChangedFiles + 5 }, (_, index) => file(`f${index}.txt`))
    const { files, truncated } = bounded(many, "/r")
    expect(files).toHaveLength(maxChangedFiles)
    expect(truncated).toBe(true)
  })

  it("never carries the diff of a file that may hold secrets, or a binary one", () => {
    const { files } = bounded(
      [
        file(".env", { added: 1, hunks: lines(1, 5) }),
        file("keys/id_rsa", { added: 1, hunks: lines(1, 5) }),
        file("a.bin", { binary: true, hunks: lines(1, 5) }),
        file("ok.txt", { added: 1, hunks: lines(1, 5) }),
      ],
      "/r",
    )
    expect(files.map(({ held, hunks }) => [held, hunks.length])).toEqual([
      [true, 0],
      [true, 0],
      [false, 0],
      [false, 1],
    ])
  })
})

describe.skipIf(!hasGit)("a change read from a git repository", () => {
  it("finds the repository from a folder inside it, and refuses a folder outside any", async ({
    repo,
  }) => {
    mkdirSync(join(repo.root, "deep", "er"), { recursive: true })
    await expect(repositoryOf(join(repo.root, "deep", "er"))).resolves.toEqual({
      ok: true,
      root: repo.root,
    })
    await expect(repositoryOf(join(repo.root, "nope"))).resolves.toMatchObject({
      ok: false,
      kind: "missing",
    })
  })

  it("is staged, unstaged and untracked files against HEAD, not ignored ones", async ({ repo }) => {
    repo.write(".gitignore", "ignored.txt\n")
    repo.write("a.txt", "one\ntwo\nthree\n")
    repo.write("b.txt", "keep\n")
    repo.write("c.txt", "move me\nsome lines\nso it is similar\nenough to rename\n")
    repo.write("gone.txt", "bye\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.write("a.txt", "one\n2\nthree\n")
    repo.git("add", "a.txt")
    repo.write("a.txt", "one\n2\nthree\nfour\n")
    renameSync(join(repo.root, "c.txt"), join(repo.root, "moved.txt"))
    repo.git("add", "-A")
    rmSync(join(repo.root, "gone.txt"))
    repo.write("new.txt", "fresh\nfile")
    repo.write("ignored.txt", "nope\n")
    repo.write("blob.bin", Buffer.from([1, 2, 0, 3]))
    repo.write("dir/nested.txt", "deep\n")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    const byPath = new Map(read.change.files.map((each) => [each.path, each]))
    expect(read.change.base).toBe("HEAD")
    expect([...byPath.keys()].toSorted()).toEqual([
      "a.txt",
      "blob.bin",
      "dir/nested.txt",
      "gone.txt",
      "moved.txt",
      "new.txt",
    ])
    expect(byPath.get("a.txt")).toMatchObject({ status: "modified", added: 2, removed: 1 })
    expect(byPath.get("gone.txt")).toMatchObject({ status: "deleted", removed: 1 })
    expect(byPath.get("moved.txt")).toMatchObject({ status: "renamed", oldPath: "c.txt" })
    expect(byPath.get("new.txt")).toMatchObject({ status: "added", added: 2 })
    expect(byPath.get("new.txt")?.hunks[0]?.lines).toEqual([
      { kind: "add", text: "fresh" },
      { kind: "add", text: "file" },
    ])
    expect(byPath.get("blob.bin")).toMatchObject({ status: "added", binary: true, hunks: [] })
    expect(byPath.has("ignored.txt")).toBe(false)
    expect(describeChange(read.change)).toEqual({
      name: `Changes · ${repo.root.split(/[\\/]/).at(-1)}`,
      detail: "6 files · +5 −2",
    })
  })

  it("diffs against the empty tree before the first commit", async ({ repo }) => {
    repo.write("a.txt", "hello\n")
    repo.git("add", "a.txt")
    repo.write("b.txt", "untracked\n")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    expect(read.change.base).toBe("HEAD (no commits yet)")
    expect(read.change.files.map(({ path, status }) => [path, status]).toSorted()).toEqual([
      ["a.txt", "added"],
      ["b.txt", "added"],
    ])
  })

  it("lists a file that may hold secrets by name only, tracked or not", async ({ repo }) => {
    repo.write("ok.txt", "a\n")
    repo.write(".env", "TOKEN=1\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.write(".env", "TOKEN=SECRET_VALUE\n")
    repo.write("id_rsa", "SECRET_KEY\n")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    expect(JSON.stringify(read.change)).not.toContain("SECRET")
    expect(read.change.files.map(({ path, held }) => [path, held]).toSorted()).toEqual([
      [".env", true],
      ["id_rsa", true],
    ])
  })

  it("reads again with the same stamp until a file changes", async ({ repo }) => {
    repo.write("a.txt", "1\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.write("a.txt", "2\n")
    const first = await changesContent(repo.root)
    expect(await changesContent(repo.root)).toEqual(first)
    repo.write("a.txt", "3\n")
    const second = await changesContent(repo.root)
    expect(second).toMatchObject({ state: "ready" })
    expect(second).not.toEqual(first)
    rmSync(repo.root, { recursive: true, force: true })
    await expect(changesContent(repo.root)).resolves.toMatchObject({
      state: "unavailable",
      reason: "missing",
    })
  })
})
