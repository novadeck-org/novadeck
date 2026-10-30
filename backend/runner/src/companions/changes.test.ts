import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { itemContent, maxChangedFiles, maxChangesBytes } from "@novadeck/protocol"

import { describe, expect, it as base } from "../test.js"
import {
  changesContent,
  describeChange,
  type Change,
  gitEnv,
  parseDiff,
  parseListing,
  readChange,
  repositoryOf,
  timing,
  waitAfter,
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
    // The repository lives in a folder of its own beside its git configuration: a file
    // that sets no global option, as there is no null device git can open on Windows.
    const holder = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-changes-")))
    resources.defer(() =>
      rmSync(holder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    )
    const config = join(holder, "gitconfig")
    writeFileSync(config, "[core]\n\tautocrlf = false\n")
    const root = join(holder, "repo")
    mkdirSync(root)
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
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
        },
      )
    git("init", "--quiet")
    // The reader runs git with the person's own configuration, which on Windows may
    // convert line endings: this repository says it does not.
    git("config", "core.autocrlf", "false")
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

describe("a change's name", () => {
  it("shows a folder's name on one line, cut to 200 characters without splitting an emoji", () => {
    const root = join(tmpdir(), `${"x".repeat(198)}😀tail`)
    const { name } = describeChange({ root, total: { files: 1, added: 0, removed: 0 } } as Change)
    expect(name).toBe(`Changes · ${"x".repeat(198)}…`)
    expect(
      describeChange({ root: "/w/a  b", total: { files: 2, added: 1, removed: 1 } } as Change).name,
    ).toBe("Changes · a b")
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

// Windows names a folder in any case, and git may spell it otherwise than the system does.
const samePath = (path: string): string =>
  process.platform === "win32" ? path.toLowerCase() : path

// What this system's files can't be: a symlink needs a privilege on Windows, and no file
// there can be named with bytes that aren't text.
const windows = process.platform === "win32"

describe.skipIf(!hasGit)("a change read from a git repository", () => {
  it("finds the repository from a folder inside it, and refuses a folder outside any", async ({
    repo,
  }) => {
    mkdirSync(join(repo.root, "deep", "er"), { recursive: true })
    const found = await repositoryOf(join(repo.root, "deep", "er"))
    expect(found).toMatchObject({ ok: true })
    expect(found.ok ? samePath(found.root) : "").toBe(samePath(repo.root))
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
    expect(read.change.files.map(({ path, secret }) => [path, secret]).toSorted()).toEqual([
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
    rmSync(repo.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
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
      expect(read.change.files.map(({ path, secret }) => [path, secret])).toEqual([
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
      { path: "notes.txt", oldPath: ".env", status: "renamed", secret: true, hunks: [] },
    ])
  })

  it("stays within what the wire carries however a change is made of lines", async ({ repo }) => {
    repo.write("big.txt", `${"1\n".repeat(150_000)}`)
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.write("big.txt", `${"2\n".repeat(150_000)}`)
    repo.write("blank.txt", "\n".repeat(200_000))
    repo.write("small.txt", "fits\n")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    expect(read.change.truncated).toBe(true)
    const byPath = new Map(read.change.files.map((each) => [each.path, each]))
    expect(byPath.get("big.txt")).toMatchObject({ listed: true, added: 150_000, removed: 150_000 })
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
      repo.git("config", "core.autocrlf", "false")
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
    repo.write("a.lock", "1\n".repeat(150_000))
    repo.write("b.lock", "\n".repeat(150_000))
    for (const name of ["c", "d", "e"]) repo.write(`${name}.big`, "1\n".repeat(70_000))
    repo.write("z.txt", "old\n")
    repo.write("zz.txt", "old\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.write("a.lock", "2\n".repeat(150_000))
    repo.write("b.lock", "x\n".repeat(150_000))
    for (const name of ["c", "d", "e"]) repo.write(`${name}.big`, "2\n".repeat(70_000))
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
    if (windows) return
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
    if (windows) return
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

  it("gives the small files after one too long to read their hunks, listing only that one", async ({
    repo,
  }) => {
    repo.write("dist/app.min.js", `${"a".repeat(9_000_000)}\n`)
    for (const name of ["x", "y", "z"]) repo.write(`src/${name}.ts`, "old\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.write("dist/app.min.js", `${"b".repeat(9_000_000)}\n`)
    for (const name of ["x", "y", "z"]) repo.write(`src/${name}.ts`, "new\n")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    const byPath = new Map(read.change.files.map((each) => [each.path, each]))
    expect(byPath.get("dist/app.min.js")).toMatchObject({ listed: true, hunks: [], added: 1 })
    for (const name of ["x", "y", "z"])
      expect(byPath.get(`src/${name}.ts`)?.hunks[0]?.lines).toEqual([
        { kind: "remove", text: "old" },
        { kind: "add", text: "new" },
      ])
    expect(read.change.truncated).toBe(true)
  })

  it("carries at most the protocol's number of files, whatever is changed", async ({ repo }) => {
    for (let index = 0; index < 160; index += 1) repo.write(`t${index}.txt`, "1\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    for (let index = 0; index < 160; index += 1) repo.write(`t${index}.txt`, "2\n")
    for (let index = 0; index < 160; index += 1) repo.write(`u${index}.txt`, "1\n")
    const { content, detail } = await changesContent(repo.root)
    expect(itemContent.parse(content)).toEqual(content)
    if (content.state !== "ready" || content.content.kind !== "changes")
      throw new Error("not ready")
    expect(content.content.files).toHaveLength(maxChangedFiles)
    expect(content.content.truncated).toBe(true)
    // Untracked files past the file cap are counted as files, not read for lines.
    expect(detail).toBe("320 files · +300 −160")
  })

  it("lists an untracked file past the per-file read bound without reading it", async ({
    repo,
  }) => {
    repo.write("big.txt", "some words\n".repeat(150_000))
    repo.write("small.txt", "fits\n")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    const byPath = new Map(read.change.files.map((each) => [each.path, each]))
    expect(byPath.get("big.txt")).toMatchObject({ listed: true, hunks: [], added: 0 })
    expect(byPath.get("small.txt")?.hunks).toHaveLength(1)
    expect(read.change.truncated).toBe(true)
  })

  it("counts a path git lists as changed and as untracked once", async ({ repo }) => {
    repo.write("a.txt", "x\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.git("rm", "--cached", "--quiet", "a.txt")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    expect(read.change.files.map(({ path }) => path)).toEqual(["a.txt"])
    expect(read.change.total.files).toBe(1)
  })

  it("shows no untracked file where status is told to show none", async ({ repo }) => {
    repo.write("a.txt", "x\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.git("config", "status.showUntrackedFiles", "no")
    repo.write("new.txt", "y\n")
    repo.write("a.txt", "z\n")
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    expect(read.change.files.map(({ path }) => path)).toEqual(["a.txt"])
  })

  it("never runs a file monitor hook program of the repository", async ({ repo }) => {
    if (windows) return
    const marker = join(repo.root, "..", "hook-ran")
    const hook = join(repo.root, "..", "hook.sh")
    writeFileSync(hook, `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 })
    repo.write("a.txt", "x\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.git("config", "core.fsmonitor", hook)
    repo.write("a.txt", "y\n")
    const read = await readChange(repo.root)
    expect(read.ok).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  // A clean filter runs for a file whose stat changed, as in the person's own git diff: a
  // way to see what git is run with, and to hold it past its time.
  const filtered = (repo: Repo, command: string) => {
    repo.write(".gitattributes", "*.txt filter=probe\n")
    repo.write("a.txt", "one\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.git("config", "filter.probe.clean", command)
    repo.write("a.txt", "two, longer\n")
  }

  it("runs git without optional locks, prompts or the runner's own GIT_ variables", async ({
    repo,
  }) => {
    if (windows) return
    const dump = join(repo.root, "..", "env.txt")
    filtered(repo, `env > '${dump}'; cat`)
    const saved = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = tmpdir()
    try {
      const read = await readChange(repo.root)
      expect(read.ok).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      else process.env.GIT_CEILING_DIRECTORIES = saved
    }
    const seen = readFileSync(dump, "utf8").split("\n")
    for (const line of ["GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C"])
      expect(seen).toContain(line)
    expect(seen).toContain(`GIT_CEILING_DIRECTORIES=${tmpdir()}`)
  })

  it("ends git and what it started when it takes too long", async ({ repo }) => {
    if (windows) return
    const pids = join(repo.root, "..", "pid.txt")
    filtered(repo, `echo $$ > '${pids}'; sleep 30`)
    const before = timing.gitMs
    timing.gitMs = 700
    try {
      const read = await readChange(repo.root)
      expect(read).toMatchObject({ ok: false, kind: "failed" })
      expect(read.ok ? "" : read.reason).toMatch(/too long/)
    } finally {
      timing.gitMs = before
    }
    const pid = Number(readFileSync(pids, "utf8").trim())
    const gone = async () => {
      for (let tries = 0; tries < 40; tries += 1) {
        try {
          process.kill(pid, 0)
        } catch {
          return true
        }
        // eslint-disable-next-line no-await-in-loop -- Waits for the process to be reaped.
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return false
    }
    expect(await gone()).toBe(true)
  })

  it("keeps git's own file monitor on, and forces a hook program off", async ({ repo }) => {
    if (windows) return
    repo.write("a.txt", "x\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.write("a.txt", "y\n")
    const runs = async (setting: string) => {
      repo.git("config", "core.fsmonitor", setting)
      const seen: (readonly string[])[] = []
      timing.saw = (args) => seen.push(args)
      try {
        await readChange(repo.root)
      } finally {
        timing.saw = undefined
      }
      // The configuration read is never told the monitor is off: it would hide the setting.
      return seen
        .filter((args) => !args.includes("--get-regexp"))
        .map((args) => args.includes("core.fsmonitor=false"))
    }
    const hook = join(repo.root, "..", "hook.sh")
    writeFileSync(hook, "#!/bin/sh\n", { mode: 0o755 })
    expect((await runs(hook)).every(Boolean)).toBe(true)
    try {
      const builtin = await runs("true")
      expect(builtin.length).toBeGreaterThan(3)
      expect(builtin.some(Boolean)).toBe(false)
    } finally {
      // The built-in monitor starts a daemon of its own for the repository.
      try {
        repo.git("fsmonitor--daemon", "stop")
      } catch {
        // None was started.
      }
    }
  })

  it("is not the change of a repository that lost its own .git and sits in another", async ({
    repo,
  }) => {
    repo.write("outer.txt", "x\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    const inner = join(repo.root, "inner")
    mkdirSync(inner)
    execFileSync("git", ["init", "--quiet"], { cwd: inner })
    expect((await changesContent(inner)).content).toMatchObject({ state: "ready" })
    rmSync(join(inner, ".git"), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    expect((await changesContent(inner)).content).toMatchObject({
      state: "unavailable",
      reason: "missing",
    })
  })

  it("counts only the untracked files it keeps", async ({ repo }) => {
    repo.write("a.txt", "x\n")
    const nested = join(repo.root, "nested")
    mkdirSync(nested)
    execFileSync("git", ["init", "--quiet"], { cwd: nested })
    const read = await readChange(repo.root)
    if (!read.ok) throw new Error(read.reason)
    expect(read.change.files.map(({ path }) => path)).toEqual(["a.txt"])
    expect(read.change.total.files).toBe(1)
  })
})

describe("how long a change waits to be read again", () => {
  it("is the usual wait for fast reads, longer for slow ones, and never more than 15 s", () => {
    expect(waitAfter(50, 2000)).toBe(2000)
    expect(waitAfter(1000, 2000)).toBe(2000)
    expect(waitAfter(1500, 2000)).toBe(6000)
    expect(waitAfter(60_000, 2000)).toBe(15_000)
  })
})

describe("the environment git runs in", () => {
  it("drops what would point git elsewhere, and keeps the rest of the person's", () => {
    const saved = { ...process.env }
    Object.assign(process.env, {
      GIT_DIR: "/elsewhere",
      GIT_INDEX_FILE: "/x",
      GIT_CONFIG_COUNT: "1",
      GIT_EXTERNAL_DIFF: "/bin/true",
      GIT_CEILING_DIRECTORIES: "/ceiling",
      GIT_EXEC_PATH: "/exec",
    })
    try {
      const env = gitEnv()
      for (const name of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_EXTERNAL_DIFF"])
        expect(env[name]).toBeUndefined()
      expect(env).toMatchObject({
        GIT_CEILING_DIRECTORIES: "/ceiling",
        GIT_EXEC_PATH: "/exec",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_LITERAL_PATHSPECS: "1",
      })
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
      Object.assign(process.env, saved)
    }
  })
})
