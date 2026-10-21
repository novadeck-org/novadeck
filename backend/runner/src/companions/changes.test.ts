import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { devNull, tmpdir } from "node:os"
import { join } from "node:path"

import { maxChangesBytes } from "@novadeck/protocol"

import { describe, expect, it as base } from "../test.js"
import {
  changesContent,
  describeChange,
  parseDiff,
  parseListing,
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

describe("the bounds of a diff", () => {
  const diffOf = (name: string, count: number, width: number) =>
    [
      `diff --git a/${name} b/${name}`,
      `--- a/${name}`,
      `+++ b/${name}`,
      `@@ -0,0 +1,${count} @@`,
      ...Array.from({ length: count }, () => `+${"x".repeat(width)}`),
      "",
    ].join("\n")

  it("lists a file whose lines would pass the budget, and leaves its room to the files after", () => {
    const budget = { left: 10_000 }
    const files = parseDiff([diffOf("big.txt", 500, 100), diffOf("small.txt", 3, 5)].join(""), {
      budget,
    })
    expect(files[0]).toMatchObject({ path: "big.txt", listed: true, hunks: [] })
    expect(files[1]?.hunks[0]?.lines).toHaveLength(3)
    expect(budget.left).toBeGreaterThan(9_000)
  })

  it("counts what encoding adds to a line, so lines of nothing are not free", () => {
    const budget = { left: maxChangesBytes }
    const [file] = parseDiff(diffOf("blank.txt", 200_000, 0), { budget })
    expect(file?.listed).toBe(true)
    expect(budget.left).toBe(maxChangesBytes)
  })

  it("does not read the body of a file it is told to skip", () => {
    const [file] = parseDiff(diffOf(".env", 3, 5), { skip: () => true })
    expect(file).toMatchObject({ path: ".env", hunks: [], added: 0 })
  })

  it("cuts a line without splitting a surrogate pair", () => {
    const [file] = parseDiff(diffOf("e.txt", 1, 0).replace("+\n", `+${"a".repeat(4095)}😀\n`))
    const text = file?.hunks[0]?.lines[0]?.text ?? ""
    expect(text.length).toBe(4095)
    expect(text.endsWith("a")).toBe(true)
  })

  it("reads git's raw and numstat listings together, with renames and binary files", () => {
    const out = [
      ":100644 100644 aaa bbb M",
      "a.txt",
      ":100644 000000 aaa 000 D",
      "g.txt",
      ":100644 100644 aaa bbb R085",
      "r.txt",
      "q.txt",
      ":100644 100644 aaa bbb M",
      "img.png",
      "1\t1\ta.txt",
      "0\t1\tg.txt",
      "2\t0\t",
      "r.txt",
      "q.txt",
      "-\t-\timg.png",
      "",
    ].join("\0")
    expect(parseListing(out)).toEqual([
      { status: "modified", path: "a.txt", oldPath: null, added: 1, removed: 1, binary: false },
      { status: "deleted", path: "g.txt", oldPath: null, added: 0, removed: 1, binary: false },
      { status: "renamed", path: "q.txt", oldPath: "r.txt", added: 2, removed: 0, binary: false },
      { status: "modified", path: "img.png", oldPath: null, added: 0, removed: 0, binary: true },
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
    const first = (await changesContent(repo.root)).content
    expect((await changesContent(repo.root)).content).toEqual(first)
    repo.write("a.txt", "3\n")
    const second = (await changesContent(repo.root)).content
    expect(second).toMatchObject({ state: "ready" })
    expect(second).not.toEqual(first)
    rmSync(repo.root, { recursive: true, force: true })
    expect((await changesContent(repo.root)).content).toMatchObject({
      state: "unavailable",
      reason: "missing",
    })
  })

  it("is not fooled by a person's own diff configuration, naming files and holding secrets", async ({
    repo,
  }) => {
    repo.write(".env", "TOKEN=SECRET_ONE\n")
    repo.write("src/a.ts", "one\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.write(".env", "TOKEN=SECRET_TWO\n")
    repo.write("src/a.ts", "two\n")
    for (const setting of [
      ["diff.noprefix", "true"],
      ["diff.mnemonicPrefix", "true"],
      ["diff.srcPrefix", "x/"],
      ["diff.dstPrefix", "y/"],
    ] as const) {
      repo.git("config", ...setting)
      // eslint-disable-next-line no-await-in-loop -- Each setting is tried on top of the last.
      const read = await readChange(repo.root)
      if (!read.ok) throw new Error(read.reason)
      expect(JSON.stringify(read.change)).not.toContain("SECRET")
      expect(read.change.files.map(({ path, held }) => [path, held])).toEqual([
        [".env", true],
        ["src/a.ts", false],
      ])
      expect(read.change.files[1]?.hunks[0]?.lines).toContainEqual({ kind: "add", text: "two" })
    }
  })

  it("holds a secret file renamed to a plain name, in either direction of detection", async ({
    repo,
  }) => {
    repo.write(".env", "A=SECRET_1\nB=SECRET_2\nC=SECRET_3\nD=SECRET_4\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.git("mv", ".env", "notes.txt")
    repo.write("notes.txt", "A=SECRET_1\nB=SECRET_2\nC=SECRET_3\nD=SECRET_4\nE=SECRET_5\n")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    expect(JSON.stringify(read.change)).not.toContain("SECRET")
    expect(read.change.files).toMatchObject([
      { path: "notes.txt", oldPath: ".env", status: "renamed", held: true, hunks: [] },
    ])
  })

  it("stays within what the wire carries however a change is made of lines", async ({ repo }) => {
    repo.write("big.txt", `${"1\n".repeat(300_000)}`)
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.write("big.txt", `${"2\n".repeat(300_000)}`)
    repo.write("blank.txt", "\n".repeat(1024 * 1024))
    repo.write("small.txt", "fits\n")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    expect(read.change.truncated).toBe(true)
    const byPath = new Map(read.change.files.map((each) => [each.path, each]))
    expect(byPath.get("big.txt")).toMatchObject({ listed: true, added: 300_000, removed: 300_000 })
    expect(byPath.get("blank.txt")).toMatchObject({ listed: true, hunks: [] })
    expect(byPath.get("small.txt")?.hunks).toHaveLength(1)
    expect(JSON.stringify(read.change).length).toBeLessThan(maxChangesBytes * 2)
  })

  it("stops reading untracked files once their budget is spent, listing the rest by name", async ({
    repo,
  }) => {
    const text = "some words on a line\n".repeat(30_000)
    for (let index = 0; index < 20; index += 1) repo.write(`u${index}.txt`, text)
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    const shown = read.change.files.filter((each) => each.hunks.length > 0)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(10)
    expect(read.change.files).toHaveLength(20)
    expect(read.change.truncated).toBe(true)
    expect(JSON.stringify(read.change).length).toBeLessThan(maxChangesBytes * 2)
  })

  it("diffs an empty SHA-256 repository against its own empty tree", async ({ repo }) => {
    let supported = true
    try {
      rmSync(join(repo.root, ".git"), { recursive: true, force: true })
      repo.git("init", "--quiet", "--object-format=sha256")
    } catch {
      supported = false
    }
    if (!supported) return
    repo.write("a.txt", "hello\n")
    repo.git("add", "a.txt")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    expect(read.change.files).toMatchObject([{ path: "a.txt", status: "added", added: 1 }])
  })

  it("fails, rather than diffing against nothing, for a HEAD git can't read", async ({ repo }) => {
    repo.write("a.txt", "x\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    writeFileSync(join(repo.root, ".git", "HEAD"), "garbage\n")
    const read = await readChange(repo.root)
    expect(read.ok).toBe(false)
  })

  it("ignores the runner's own GIT_ variables", async ({ repo }) => {
    repo.write("a.txt", "x\n")
    repo.git("add", "-A")
    const saved = process.env.GIT_DIR
    process.env.GIT_DIR = join(tmpdir(), "no-such-git-dir")
    try {
      const read = await readChange(repo.root)
      if (!read.ok) throw new Error(read.reason)
      expect(read.change.files.map(({ path }) => path)).toEqual(["a.txt"])
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
    }
  })

  it("says what git said when it refuses a folder, not only its first words", async ({ repo }) => {
    const broken = join(repo.root, "broken")
    mkdirSync(broken)
    writeFileSync(join(broken, ".git"), "garbage\n")
    const found = await repositoryOf(broken)
    expect(found).toMatchObject({ ok: false, kind: "failed" })
    expect(found.ok ? "" : found.reason).toMatch(/invalid gitfile format/)
  })

  it("shows invisible characters in a name as U+FFFD", async ({ repo }) => {
    repo.write("a\u202eb.txt", "x\n")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    expect(read.change.files.map(({ path }) => path)).toEqual(["a\uFFFDb.txt"])
  })

  it("keeps the hunks of small files after one too big to show, whatever the order", async ({
    repo,
  }) => {
    repo.write("a.lock", "1\n".repeat(2_000_000))
    repo.write("b.lock", "\n".repeat(3_000_000))
    for (const name of ["c", "d", "e"]) repo.write(`${name}.big`, "1\n".repeat(400_000))
    repo.write("z.txt", "old\n")
    repo.write("zz.txt", "old\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.write("a.lock", "2\n".repeat(2_000_000))
    repo.write("b.lock", "x\n".repeat(3_000_000))
    for (const name of ["c", "d", "e"]) repo.write(`${name}.big`, "2\n".repeat(400_000))
    repo.write("z.txt", "new\n")
    repo.write("zz.txt", "new\n")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    const byPath = new Map(read.change.files.map((each) => [each.path, each]))
    expect(byPath.get("a.lock")).toMatchObject({ listed: true, hunks: [] })
    expect(byPath.get("e.big")).toMatchObject({ listed: true, hunks: [] })
    for (const name of ["z.txt", "zz.txt"])
      expect(byPath.get(name)?.hunks[0]?.lines).toEqual([
        { kind: "remove", text: "old" },
        { kind: "add", text: "new" },
      ])
    expect(read.change.truncated).toBe(true)
  })

  it("shows both sides of a file made a symlink", async ({ repo }) => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")
    repo.write("t.txt", `${lines}\n`)
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    rmSync(join(repo.root, "t.txt"))
    symlinkSync("/etc/hostname", join(repo.root, "t.txt"))
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    const [file] = read.change.files
    expect(file).toMatchObject({ path: "t.txt", added: 1, removed: 20 })
    const kinds = file?.hunks.flatMap((hunk) => hunk.lines.map((line) => line.kind)) ?? []
    expect(kinds.filter((kind) => kind === "remove")).toHaveLength(20)
    expect(file?.hunks.flatMap((hunk) => hunk.lines)).toContainEqual({
      kind: "add",
      text: "/etc/hostname",
    })
  })

  it("names unicode files and reads English git messages whatever the locale", async ({ repo }) => {
    repo.write("zażółć/gęślą.txt", "jaźń\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.write("zażółć/gęślą.txt", "jaźń\nżółw\n")
    repo.write("nowy-żółty.txt", "x\n")
    const saved = process.env.LC_ALL
    process.env.LC_ALL = "pl_PL.UTF-8"
    try {
      const read = await readChange(repo.root)
      if (!read.ok) throw new Error(read.reason)
      expect(read.change.files.map(({ path }) => path).toSorted()).toEqual([
        "nowy-żółty.txt",
        "zażółć/gęślą.txt",
      ])
      expect(
        read.change.files.find((each) => each.path.endsWith("gęślą.txt"))?.hunks[0]?.lines,
      ).toContainEqual({
        kind: "add",
        text: "żółw",
      })
      await expect(repositoryOf(tmpdir())).resolves.toMatchObject({ kind: "not-a-repository" })
    } finally {
      if (saved === undefined) delete process.env.LC_ALL
      else process.env.LC_ALL = saved
    }
  })

  it("gives a tracked file whose name isn't valid UTF-8 its hunk", async ({ repo }) => {
    const bad = Buffer.concat([
      Buffer.from(`${repo.root}/bad`),
      Buffer.from([0xff]),
      Buffer.from("name.txt"),
    ])
    try {
      writeFileSync(bad, "one\n")
    } catch {
      // This system's files can't be named so.
      return
    }
    repo.write("ok.txt", "one\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    writeFileSync(bad, "two\n")
    repo.write("ok.txt", "two\n")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    expect(read.change.truncated).toBe(false)
    const byPath = new Map(read.change.files.map((each) => [each.path, each]))
    expect(byPath.get("bad\uFFFDname.txt")?.hunks[0]?.lines).toContainEqual({
      kind: "add",
      text: "two",
    })
    expect(byPath.get("ok.txt")?.hunks).toHaveLength(1)
  })
})
