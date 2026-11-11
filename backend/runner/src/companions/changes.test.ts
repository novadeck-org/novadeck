import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  companionLimits,
  itemContent,
  maxChangedFiles,
  maxChangeLayers,
  maxChangesBytes,
} from "@novadeck/protocol"
import { afterEach } from "vitest"

import { describe, expect, it as base } from "../test.js"
import {
  maxUntrackedBytes,
  parseDiff,
  parseListing,
  repositoryOf,
  timing,
  waitAfter,
} from "./changes.js"
import { findRepository, LayerReader } from "./layers.js"

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
      rmSync(holder, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
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
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: config,
            GIT_CONFIG_NOSYSTEM: "1",
          },
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
    expect(parsed).toMatchObject({
      path: "src/a.ts",
      status: "modified",
      added: 1,
      removed: 1,
    })
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
      files.map(({ path, status, oldPath, binary }) => ({
        path,
        status,
        oldPath,
        binary,
      })),
    ).toEqual([
      { path: "new.txt", status: "added", oldPath: null, binary: false },
      { path: "gone.txt", status: "deleted", oldPath: null, binary: false },
      {
        path: "to name.txt",
        status: "renamed",
        oldPath: "from name.txt",
        binary: false,
      },
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
    expect(files[0]).toMatchObject({
      path: "big.txt",
      listed: true,
      hunks: [],
    })
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
      {
        status: "modified",
        path: "a.txt",
        oldPath: null,
        added: 1,
        removed: 1,
        binary: false,
      },
      {
        status: "deleted",
        path: "g.txt",
        oldPath: null,
        added: 0,
        removed: 1,
        binary: false,
      },
      {
        status: "renamed",
        path: "q.txt",
        oldPath: "r.txt",
        added: 2,
        removed: 0,
        binary: false,
      },
      {
        status: "modified",
        path: "img.png",
        oldPath: null,
        added: 0,
        removed: 0,
        binary: true,
      },
    ])
  })
})

// Windows names a folder in any case, and git may spell it otherwise than the system does.

// Windows names a folder in any case, and git may spell it otherwise than the system does.
const samePath = (path: string): string =>
  process.platform === "win32" ? path.toLowerCase() : path

// What this system's files can't be: a symlink needs a privilege on Windows, and no file
// there can be named with bytes that aren't text.
const windows = process.platform === "win32"

// A repository with a main branch holding one file, and a branch checked out from it.
const branched = (repo: Repo) => {
  repo.git("checkout", "--quiet", "-b", "main")
  repo.write("base.txt", "base\n")
  repo.git("add", "-A")
  repo.git("commit", "--quiet", "-m", "base")
  repo.git("checkout", "--quiet", "-b", "feature")
}
const commit = (repo: Repo, message: string, files: Record<string, string | Buffer>): string => {
  for (const [path, text] of Object.entries(files)) repo.write(path, text)
  repo.git("add", "-A")
  repo.git("commit", "--quiet", "-m", message)
  return repo.git("rev-parse", "HEAD").trim()
}

const opened: LayerReader[] = []
const reader = () => {
  const made = new LayerReader(() => undefined)
  opened.push(made)
  return made
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map((each) => each.close()))
})
const layersOf = async (readers: LayerReader, root: string) => {
  const read = await readers.read(root)
  if (!read.ok) throw new Error(read.reason)
  if (read.change.content.state !== "ready" || read.change.content.content.kind !== "changes")
    throw new Error("not a change")
  return { ...read.change, change: read.change.content.content }
}
const diffOf = async (readers: LayerReader, root: string, path: string, layers: string[]) => {
  const read = await readers.file(root, path, layers)
  if (!read.ok) throw new Error(read.reason)
  return read.diff
}

describe.skipIf(!hasGit)("the layers of a change read from a git repository", () => {
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

  it("is the commits since the merge base with main, newest first, then the uncommitted work", async ({
    repo,
  }) => {
    branched(repo)
    const first = commit(repo, "Add a", { "a.txt": "1\n2\n3\n" })
    const second = commit(repo, "Change a, add b", {
      "a.txt": "1\n2\n3\n4\n",
      "b.txt": "b\n",
    })
    repo.write("a.txt", "1\n2\n3\n4\n5\n")
    const read = await layersOf(reader(), repo.root)

    expect(read.change.base).toBe("main")
    expect(read.change.layers.map(({ id, kind, subject }) => [id, kind, subject])).toEqual([
      ["uncommitted", "uncommitted", ""],
      [second, "commit", "Change a, add b"],
      [first, "commit", "Add a"],
    ])
    expect(read.change.layers[0]).toMatchObject({
      time: null,
      added: 1,
      removed: 0,
    })
    expect(read.change.layers[0]?.files).toMatchObject([{ path: "a.txt", status: "modified" }])
    expect(
      read.change.layers[1]?.files.map(({ path, status, added }) => [path, status, added]),
    ).toEqual([
      ["a.txt", "modified", 1],
      ["b.txt", "added", 1],
    ])
    expect(read.change.layers[2]?.time).toBeGreaterThan(1_500_000_000_000)
    expect(read.detail).toBe("2 files · +6 −0")
    // The whole change's own list, as `changeRange` gives it over every layer.
    expect(read.change.files.map(({ path, added }) => [path, added])).toEqual([
      ["a.txt", 5],
      ["b.txt", 1],
    ])
    expect(read.name).toBe(`Changes · ${repo.root.split(/[\\/]/).at(-1)}`)
  })

  it("counts untracked files in the uncommitted layer, but not ignored ones", async ({ repo }) => {
    branched(repo)
    repo.write(".gitignore", "ignored.txt\n")
    repo.write("new.txt", "one\ntwo\n")
    repo.write("ignored.txt", "nope\n")
    repo.write("sub/deep.txt", "x\n")
    const read = await layersOf(reader(), repo.root)

    expect(read.change.layers).toHaveLength(1)
    expect(
      read.change.layers[0]?.files.map(({ path, status }) => [path, status]).toSorted(),
    ).toEqual([
      [".gitignore", "added"],
      ["new.txt", "added"],
      ["sub/deep.txt", "added"],
    ])
  })

  it("leaves an untracked file past the snapshot's size out, and says the layer is cut", async ({
    repo,
  }) => {
    branched(repo)
    repo.write("small.txt", "x\n")
    repo.write("huge.txt", "x".repeat(maxUntrackedBytes + 1))
    const read = await layersOf(reader(), repo.root)

    expect(read.change.layers[0]?.files.map(({ path }) => path)).toEqual(["small.txt"])
    expect(read.change.layers[0]?.truncated).toBe(true)
    expect(read.change.truncated).toBe(true)
  })

  it("is only the uncommitted work on main itself, and against HEAD where there is no main", async ({
    repo,
  }) => {
    repo.git("checkout", "--quiet", "-b", "trunk")
    commit(repo, "one", { "a.txt": "1\n" })
    commit(repo, "two", { "a.txt": "1\n2\n" })
    repo.write("a.txt", "1\n2\n3\n")
    const none = await layersOf(reader(), repo.root)
    expect(none.change.base).toBe("HEAD")
    expect(none.change.layers.map(({ id }) => id)).toEqual(["uncommitted"])

    repo.git("branch", "-m", "main")
    const onMain = await layersOf(reader(), repo.root)
    expect(onMain.change.base).toBe("main")
    expect(onMain.change.layers.map(({ id }) => id)).toEqual(["uncommitted"])
  })

  it("is only the uncommitted work before the first commit, all of it new", async ({ repo }) => {
    repo.write("a.txt", "x\ny\n")
    const readers = reader()
    const read = await layersOf(readers, repo.root)
    expect(read.change.base).toBe("HEAD (no commits yet)")
    expect(read.change.layers).toMatchObject([
      {
        id: "uncommitted",
        files: [{ path: "a.txt", status: "added", added: 2 }],
      },
    ])
    const diff = await diffOf(readers, repo.root, "a.txt", ["uncommitted"])
    expect(diff.run).toMatchObject({ before: null, after: "x\ny\n" })
  })

  it("says there is no common history where main shares none with HEAD", async ({ repo }) => {
    repo.git("checkout", "--quiet", "-b", "main")
    commit(repo, "main", { "m.txt": "m\n" })
    repo.git("checkout", "--quiet", "--orphan", "other")
    commit(repo, "other", { "o.txt": "o\n" })
    const read = await layersOf(reader(), repo.root)
    expect(read.change.base).toBe("main (no common history)")
    expect(read.change.layers.map(({ id }) => id)).toEqual(["uncommitted"])
  })

  // Not on Windows: a 250-character ref's file runs past the paths Windows allows before the
  // name is ever read, and cutting it is the same there.
  it.skipIf(windows)(
    "cuts a long main branch's name so the note fits the protocol",
    async ({ repo }) => {
      const name = "m".repeat(250)
      repo.git("checkout", "--quiet", "-b", name)
      commit(repo, "main", { "m.txt": "m\n" })
      repo.git("checkout", "--quiet", "--orphan", "other")
      commit(repo, "other", { "o.txt": "o\n" })
      repo.git("branch", "-m", "-f", name, "main")
      const read = await layersOf(reader(), repo.root)
      expect(read.change.base.endsWith(" (no common history)")).toBe(true)
      expect(read.change.base.length).toBeLessThanOrEqual(256)
    },
  )

  it("has a new stamp when a line is edited though no count changes", async ({ repo }) => {
    branched(repo)
    commit(repo, "a", { "a.txt": "one\n" })
    repo.write("a.txt", "two\n")
    const readers = reader()
    const first = (await layersOf(readers, repo.root)).content
    repo.write("a.txt", "TWO\n")
    const second = (await layersOf(readers, repo.root)).content
    expect(
      first.state === "ready" && second.state === "ready" && first.stamp !== second.stamp,
    ).toBe(true)
  })

  it("cuts a subject of any length to what the protocol carries", async ({ repo }) => {
    branched(repo)
    repo.write("a.txt", "x\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", `${"long ".repeat(200)}\n\nsecond paragraph`)
    const read = await layersOf(reader(), repo.root)
    expect(read.change.layers[1]!.subject.length).toBeLessThanOrEqual(companionLimits.name)
    expect(itemContent.safeParse(read.content).success).toBe(true)
  })

  it("reads commits though the person's log settings show signatures", async ({ repo }) => {
    branched(repo)
    commit(repo, "a", { "a.txt": "x\n" })
    repo.git("config", "log.showSignature", "true")
    const read = await layersOf(reader(), repo.root)
    expect(read.change.layers.map(({ subject }) => subject)).toEqual(["", "a"])
  })

  it("is the net change in the item's detail, not its layers added up", async ({ repo }) => {
    branched(repo)
    commit(repo, "a", { "a.txt": "1\n2\n3\n" })
    commit(repo, "b", { "a.txt": "1\n2\n3\n4\n" })
    commit(repo, "c", { "a.txt": "1\n2\n" })
    const read = await layersOf(reader(), repo.root)
    expect(read.detail).toBe("1 file · +2 −0")
  })

  it("never writes the person's own index", async ({ repo }) => {
    branched(repo)
    commit(repo, "a", { "a.txt": "1\n" })
    repo.write("a.txt", "2\n")
    repo.write("untracked.txt", "u\n")
    const index = join(repo.root, ".git", "index")
    const before = readFileSync(index)
    await layersOf(reader(), repo.root)
    expect(readFileSync(index).equals(before)).toBe(true)
    expect(repo.git("status", "--porcelain").split("\n").filter(Boolean).toSorted()).toEqual([
      " M a.txt",
      "?? untracked.txt",
    ])
  })

  it("counts lines that only changed whitespace apart, as re-indented", async ({ repo }) => {
    branched(repo)
    commit(repo, "wrap", { "a.ts": "if (x) {\n  a()\n  b()\n}\n" })
    commit(repo, "indent", {
      "a.ts": "if (x) {\n    a()\n    b()\n    c()\n}\n",
    })
    const read = await layersOf(reader(), repo.root)

    expect(read.change.layers[1]?.files).toMatchObject([
      { path: "a.ts", added: 1, removed: 0, reindented: 2 },
    ])
  })

  it("reads again with the same stamp until something changes", async ({ repo }) => {
    branched(repo)
    commit(repo, "a", { "a.txt": "1\n" })
    const readers = reader()
    const first = (await layersOf(readers, repo.root)).content
    expect((await layersOf(readers, repo.root)).content).toEqual(first)
    repo.write("a.txt", "1\n2\n")
    const second = (await layersOf(readers, repo.root)).content
    expect(second).not.toEqual(first)
    expect(itemContent.safeParse(second).success).toBe(true)
  })

  it("lists a file that may hold secrets by name only, and never reads it", async ({ repo }) => {
    branched(repo)
    const sha = commit(repo, "env", { ".env": "TOKEN=1\n", "ok.txt": "a\n" })
    repo.write(".env", "TOKEN=SECRET_VALUE\n")
    repo.write("id_rsa", "SECRET_KEY\n")
    const readers = reader()
    const read = await layersOf(readers, repo.root)

    expect(JSON.stringify(read.change)).not.toContain("SECRET")
    // Both are listed by name; the untracked one is not even hashed.
    expect(
      read.change.layers[0]?.files.map(({ path, secret, status, added, removed }) => [
        path,
        secret,
        status,
        added,
        removed,
      ]),
    ).toEqual([
      [".env", true, "modified", 1, 1],
      ["id_rsa", true, "added", 0, 0],
    ])
    const range = await readers.range(repo.root, ["uncommitted"])
    if (!range.ok) throw new Error(range.reason)
    expect(range.range.files.map(({ path }) => path)).toEqual([".env", "id_rsa"])
    const named = await diffOf(readers, repo.root, "id_rsa", ["uncommitted"])
    expect(JSON.stringify(named)).not.toContain("SECRET")
    expect(named.run).toMatchObject({
      hunks: [],
      before: null,
      after: null,
    })
    const one = await diffOf(readers, repo.root, ".env", ["uncommitted", sha])
    expect(JSON.stringify(one)).not.toContain("SECRET")
    expect(JSON.stringify(one)).not.toContain("TOKEN=1")
    expect(one.run).toMatchObject({
      big: false,
      hunks: [],
      before: null,
      after: null,
    })
    expect(one.run?.file.secret).toBe(true)
  })

  it("keeps at most the protocol's number of layers", async ({ repo }) => {
    branched(repo)
    const many = Object.fromEntries(
      Array.from({ length: maxChangedFiles + 5 }, (_, at) => [`f${at}.txt`, "x\n"]),
    )
    commit(repo, "many files", many)
    for (let at = 0; at < maxChangeLayers + 3; at += 1)
      repo.git("commit", "--quiet", "--allow-empty", "-m", `empty ${at}`)
    const read = await layersOf(reader(), repo.root)

    expect(read.change.layers).toHaveLength(maxChangeLayers)
    expect(read.change.truncated).toBe(true)
    expect(itemContent.safeParse(read.content).success).toBe(true)
  })

  it("lists the files of a commit with more files than the protocol carries, cut and flagged", async ({
    repo,
  }) => {
    branched(repo)
    const many = Object.fromEntries(
      Array.from({ length: maxChangedFiles + 5 }, (_, at) => [`f${at}.txt`, "x\n"]),
    )
    commit(repo, "many files", many)
    const read = await layersOf(reader(), repo.root)

    const layer = read.change.layers[1]!
    expect(layer.files).toHaveLength(maxChangedFiles)
    expect(layer.added).toBe(maxChangedFiles + 5)
    expect(layer.truncated).toBe(true)
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
    expect(await findRepository(inner)).toMatchObject({ ok: true })
    rmSync(join(inner, ".git"), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
    expect(await findRepository(inner)).toEqual({ ok: false, missing: true })
  })

  it("never runs a file monitor hook program of the repository", async ({ repo }) => {
    if (windows) return
    const marker = join(repo.root, "..", "hook-ran")
    const hook = join(repo.root, "..", "hook.sh")
    writeFileSync(hook, `#!/bin/sh\necho ran > '${marker}'\n`, {
      mode: 0o755,
    })
    branched(repo)
    commit(repo, "a", { "a.txt": "x\n" })
    repo.git("config", "core.fsmonitor", hook)
    repo.write("a.txt", "y\n")
    const readers = reader()
    const read = await readers.read(repo.root)
    expect(read.ok).toBe(true)
    await readers.file(repo.root, "a.txt", ["uncommitted"])
    expect(existsSync(marker)).toBe(false)
  })

  // A clean filter runs for a file whose stat changed, as in the person's own git diff: a
  // way to see what git is run with, and to hold it past its time.
  const filtered = (repo: Repo, command: string) => {
    branched(repo)
    repo.write(".gitattributes", "*.txt filter=probe\n")
    commit(repo, "a", { "a.txt": "one\n" })
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
      const read = await reader().read(repo.root)
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
    timing.gitMs = 300
    try {
      const read = await reader().read(repo.root)
      expect(read).toMatchObject({ ok: false, kind: "failed" })
    } finally {
      timing.gitMs = before
    }
    const pid = Number(readFileSync(pids, "utf8").trim())
    const gone = async () => {
      for (let tries = 0; tries < 60; tries += 1) {
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
})

describe.skipIf(!hasGit)("one file of a change for a selection of its layers", () => {
  // main: a.ts "1".."3"; feature: c1 changes a.ts, c2 adds b.ts, c3 changes a.ts again;
  // then an uncommitted edit of a.ts and an untracked c.ts.
  const history = (repo: Repo) => {
    branched(repo)
    repo.write("a.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "--amend", "-m", "base")
    repo.git("branch", "-f", "main")
    const c1 = commit(repo, "c1", {
      "a.ts": "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    })
    const c2 = commit(repo, "c2", { "b.ts": "b\n" })
    const c3 = commit(repo, "c3", {
      "a.ts": "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n",
    })
    repo.write("a.ts", "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\neleven\n")
    repo.write("c.ts", "c\n")
    return { c1, c2, c3 }
  }
  const linesOf = (run: { hunks: { lines: { kind: string; text: string }[] }[] } | undefined) =>
    run?.hunks.flatMap((hunk) =>
      hunk.lines
        .filter((line) => line.kind !== "context")
        .map((line) => `${line.kind}:${line.text}`),
    )

  it("takes in the layers between the ends of a selection, and leaves out those not there", async ({
    repo,
  }) => {
    const { c1, c3 } = history(repo)
    const diff = await diffOf(reader(), repo.root, "a.ts", [c3, c1, "ignored-unknown"])

    expect(diff.run?.layers).toEqual([c3, expect.any(String), c1])
    expect(linesOf(diff.run ?? undefined)).toEqual([
      "remove:one",
      "add:ONE",
      "remove:ten",
      "add:TEN",
    ])
  })

  it("diffs layers that follow one another as one range", async ({ repo }) => {
    const { c1, c2, c3 } = history(repo)
    const diff = await diffOf(reader(), repo.root, "a.ts", [c1, c2, c3])

    expect(diff.run).not.toBeNull()
    expect(diff.run?.layers).toEqual([c3, c2, c1])
    expect(linesOf(diff.run ?? undefined)).toEqual([
      "remove:one",
      "add:ONE",
      "remove:ten",
      "add:TEN",
    ])
    expect(diff.run?.before).toBe("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n")
    expect(diff.run?.after).toBe("ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n")
    expect(diff.run?.file).toMatchObject({
      added: 2,
      removed: 2,
      status: "modified",
    })
  })

  it("joins the uncommitted work to the commits under it, and shows it alone when it is alone", async ({
    repo,
  }) => {
    const { c2, c3 } = history(repo)
    const readers = reader()

    const joined = await diffOf(readers, repo.root, "a.ts", ["uncommitted", c3, c2])
    expect(joined.run).not.toBeNull()
    expect(joined.run?.layers).toEqual(["uncommitted", c3, c2])
    expect(linesOf(joined.run ?? undefined)).toEqual(["remove:ten", "add:TEN", "add:eleven"])

    const alone = await diffOf(readers, repo.root, "a.ts", ["uncommitted"])
    expect(linesOf(alone.run ?? undefined)).toEqual(["add:eleven"])
    expect(alone.run?.after).toContain("eleven")
    expect(alone.run?.before).not.toContain("eleven")
  })

  it("lists the files of a range as git does, a file renamed inside it as one", async ({
    repo,
  }) => {
    branched(repo)
    const c1 = commit(repo, "other", { "other.txt": "o\n" })
    repo.git("mv", "base.txt", "b.txt")
    repo.git("commit", "--quiet", "-am", "rename")
    const c2 = repo.git("rev-parse", "HEAD").trim()
    commit(repo, "temp", { "t.txt": "t\n" })
    const c3 = repo.git("rev-parse", "HEAD").trim()
    repo.git("rm", "--quiet", "t.txt")
    repo.git("commit", "--quiet", "-m", "drop temp")
    const c4 = repo.git("rev-parse", "HEAD").trim()
    const readers = reader()

    const range = await readers.range(repo.root, [c1, c2, c3, c4])
    if (!range.ok) throw new Error(range.reason)
    expect(range.range.files).toMatchObject([
      { path: "b.txt", oldPath: "base.txt", status: "renamed" },
      { path: "other.txt", status: "added" },
    ])
    // The old name still opens the one range.
    const byOld = await diffOf(readers, repo.root, "base.txt", [c2, c1])
    expect(byOld.run).not.toBeNull()
    expect(byOld.run?.file).toMatchObject({ path: "b.txt" })
    expect(byOld.run?.after).toBe("base\n")
  })

  it("starts a range that reaches the oldest layer at the merge base, so main's own changes are no part of it", async ({
    repo,
  }) => {
    branched(repo)
    const own = commit(repo, "own", { "own.txt": "o\n" })
    repo.git("checkout", "--quiet", "main")
    commit(repo, "main moves", { "main.txt": "m\n" })
    repo.git("checkout", "--quiet", "feature")
    repo.git("merge", "--quiet", "--no-ff", "-m", "merge main", "main")
    const merged = repo.git("rev-parse", "HEAD").trim()
    const readers = reader()

    const read = await layersOf(readers, repo.root)
    // The merge itself did nothing: what it brought in from main is main's.
    const merge = read.change.layers.find((layer) => layer.id === merged)!
    expect(merge.files).toEqual([])
    const range = await readers.range(repo.root, [merged, own])
    if (!range.ok) throw new Error(range.reason)
    expect(range.range.files.map(({ path }) => path)).toEqual(["own.txt"])
    expect((await diffOf(readers, repo.root, "main.txt", [merged, own])).run).toBeNull()
  })

  it("has no run for a file the selection did not change", async ({ repo }) => {
    const { c2 } = history(repo)
    const diff = await diffOf(reader(), repo.root, "a.ts", [c2])
    expect(diff.run).toBeNull()
  })

  it("gives an untracked file as added, with only its new side, and a deleted one only its old", async ({
    repo,
  }) => {
    history(repo)
    repo.git("rm", "--quiet", "b.ts")
    const readers = reader()
    const added = await diffOf(readers, repo.root, "c.ts", ["uncommitted"])
    expect(added.run).toMatchObject({
      before: null,
      after: "c\n",
      file: { status: "added" },
    })
    expect(linesOf(added.run ?? undefined)).toEqual(["add:c"])
    const deleted = await diffOf(readers, repo.root, "b.ts", ["uncommitted"])
    expect(deleted.run).toMatchObject({
      before: "b\n",
      after: null,
      file: { status: "deleted" },
    })
  })

  it("follows a rename, with the old path and both sides", async ({ repo }) => {
    branched(repo)
    repo.write("old.ts", "a\nb\nc\nd\ne\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "--amend", "-m", "base")
    repo.git("branch", "-f", "main")
    repo.git("mv", "old.ts", "new.ts")
    repo.git("commit", "--quiet", "-am", "rename")
    const renamed = repo.git("rev-parse", "HEAD").trim()
    const diff = await diffOf(reader(), repo.root, "new.ts", [renamed])
    expect(diff.run).toMatchObject({
      file: { status: "renamed", oldPath: "old.ts", path: "new.ts" },
      before: "a\nb\nc\nd\ne\n",
      after: "a\nb\nc\nd\ne\n",
    })
  })

  it("names a binary file and sends no text", async ({ repo }) => {
    branched(repo)
    const sha = commit(repo, "png", {
      "i.png": Buffer.from([0x89, 0x50, 0, 1, 2, 0, 3]),
    })
    const read = await layersOf(reader(), repo.root)
    expect(read.change.layers[1]?.files).toMatchObject([{ path: "i.png", binary: true }])
    const diff = await diffOf(reader(), repo.root, "i.png", [sha])
    expect(diff.run).toMatchObject({
      hunks: [],
      before: null,
      after: null,
    })
  })

  it("sends hunks only, and no sides, past the bounds", async ({ repo }) => {
    branched(repo)
    const line = "x".repeat(3000)
    const big = Array.from({ length: 1500 }, (_, at) => `${at}${line}`).join("\n") + "\n"
    const sha = commit(repo, "big", { "big.txt": big, "small.txt": "s\n" })
    const readers = reader()
    const huge = await diffOf(readers, repo.root, "big.txt", [sha])
    expect(huge.run).toMatchObject({
      big: true,
      hunks: [],
      before: null,
      after: null,
    })
    expect(huge.run?.file.added).toBe(1500)
    const small = await diffOf(readers, repo.root, "small.txt", [sha])
    expect(small.run).toMatchObject({ big: false, after: "s\n" })

    // A file whose text passes the side bound but whose diff fits has hunks and no sides.
    const text =
      Array.from({ length: 600 }, (_, at) => `${at}${"y".repeat(1000)}`).join("\n") + "\n"
    const second = commit(repo, "wide", { "wide.txt": text })
    const wide = await diffOf(readers, repo.root, "wide.txt", [second])
    expect(wide.run?.hunks.length).toBeGreaterThan(0)
    expect(wide.run).toMatchObject({
      big: false,
      before: null,
      after: null,
    })
    expect(itemContentSize(wide)).toBeLessThan(5 * 1024 * 1024)
  })
})

const itemContentSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

// A feature branch that merges main twice: f1, merge1 (brings m1), f2, merge2 (brings m2), f3.
const merging = (repo: Repo) => {
  branched(repo)
  const f1 = commit(repo, "f1", { "f1.txt": "f1\n" })
  repo.git("checkout", "--quiet", "main")
  commit(repo, "m1", { "m1.txt": "m1\n" })
  repo.git("checkout", "--quiet", "feature")
  repo.git("merge", "--quiet", "--no-edit", "-m", "merge1", "main")
  const merge1 = repo.git("rev-parse", "HEAD").trim()
  const f2 = commit(repo, "f2", { "f2.txt": "f2\n" })
  repo.git("checkout", "--quiet", "main")
  commit(repo, "m2", { "m2.txt": "m2\n" })
  repo.git("checkout", "--quiet", "feature")
  repo.git("merge", "--quiet", "--no-edit", "-m", "merge2", "main")
  const merge2 = repo.git("rev-parse", "HEAD").trim()
  const f3 = commit(repo, "f3", { "f3.txt": "f3\n" })
  return { f1, merge1, f2, merge2, f3 }
}

describe.skipIf(!hasGit)("the merges of a change", () => {
  const rangeFiles = async (readers: LayerReader, root: string, layers: string[]) => {
    const range = await readers.range(root, layers)
    if (!range.ok) throw new Error(range.reason)
    return range.range.files.map(({ path, status }) => `${status}:${path}`)
  }

  it("shows a merge as what it did itself, nothing where it only brought main in", async ({
    repo,
  }) => {
    const { f1, merge1, f2, merge2, f3 } = merging(repo)
    const read = await layersOf(reader(), repo.root)

    const files = (id: string) =>
      read.change.layers
        .find((layer) => layer.id === id)!
        .files.map(({ path, status }) => `${status}:${path}`)
    expect(files(f3)).toEqual(["added:f3.txt"])
    expect(files(merge2)).toEqual([])
    expect(files(f2)).toEqual(["added:f2.txt"])
    expect(files(merge1)).toEqual([])
    expect(files(f1)).toEqual(["added:f1.txt"])
    expect(read.detail).toBe("3 files · +3 −0")
    expect(read.change.files.map(({ path }) => path)).toEqual(["f1.txt", "f2.txt", "f3.txt"])
  })

  it("shows the work of a range, whatever main brought in inside it or after", async ({ repo }) => {
    const { f1, merge1, f2, merge2, f3 } = merging(repo)
    const readers = reader()

    // The whole of it is what `git diff main...HEAD` says.
    const truth = repo
      .git("diff", "--name-only", "main...HEAD")
      .trim()
      .split("\n")
      .map((path) => `added:${path}`)
    expect(await rangeFiles(readers, repo.root, [f3, merge2, f2, merge1, f1])).toEqual(truth)
    expect(
      await rangeFiles(readers, repo.root, ["uncommitted", f3, merge2, f2, merge1, f1]),
    ).toEqual(truth)
    expect(await rangeFiles(readers, repo.root, [f3, merge2, f2])).toEqual([
      "added:f2.txt",
      "added:f3.txt",
    ])
    expect(await rangeFiles(readers, repo.root, [f2, merge1, f1])).toEqual([
      "added:f1.txt",
      "added:f2.txt",
    ])
    expect(await rangeFiles(readers, repo.root, [merge2, f2, merge1])).toEqual(["added:f2.txt"])
    expect(await rangeFiles(readers, repo.root, [merge1, f1])).toEqual(["added:f1.txt"])
    expect(await rangeFiles(readers, repo.root, [merge2])).toEqual([])
    expect(await rangeFiles(readers, repo.root, [merge2, f2])).toEqual(["added:f2.txt"])
    // A file main brought in is no part of any range's diff.
    const all = [f3, merge2, f2, merge1, f1]
    const mains = await Promise.all(
      ["m1.txt", "m2.txt"].map((path) => diffOf(readers, repo.root, path, all)),
    )
    expect(mains.map((each) => each.run)).toEqual([null, null])
  })

  it("shows how a merge resolved a conflict, and only that", async ({ repo }) => {
    branched(repo)
    const own = commit(repo, "own", { "c.txt": "mine\n" })
    repo.git("checkout", "--quiet", "main")
    commit(repo, "theirs", { "c.txt": "theirs\n" })
    repo.git("checkout", "--quiet", "feature")
    expect(() => repo.git("merge", "--quiet", "--no-edit", "main")).toThrow()
    repo.write("c.txt", "resolved\n")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "resolve")
    const resolved = repo.git("rev-parse", "HEAD").trim()
    const readers = reader()

    const read = await layersOf(readers, repo.root)
    const merge = read.change.layers.find((layer) => layer.id === resolved)!
    expect(merge.files.map(({ path }) => path)).toEqual(["c.txt"])
    const diff = await diffOf(readers, repo.root, "c.txt", [resolved])
    expect(diff.run?.after).toBe("resolved\n")
    expect(await rangeFiles(readers, repo.root, [resolved, own])).toEqual(
      repo
        .git("diff", "--name-status", "main...HEAD")
        .trim()
        .split("\n")
        .map((each) => each.replace(/^M\t/, "modified:").replace(/^A\t/, "added:")),
    )
  })

  // A conflict resolved by a merge of main, a branch of the checkout's own merged in (x), and
  // an octopus whose first parent is on the branch (o1) and second is cut from it (o2).
  const featured = (repo: Repo) => {
    repo.write("s.txt", "a\nb\nc\n")
    repo.git("checkout", "--quiet", "-b", "main")
    repo.git("add", "-A")
    repo.git("commit", "--quiet", "-m", "base")
    repo.git("checkout", "--quiet", "-b", "feature")
    commit(repo, "f1", { "s.txt": "a\nFEAT\nc\n" })
    repo.git("checkout", "--quiet", "main")
    commit(repo, "m1", { "s.txt": "a\nMAIN\nc\n", "m.txt": "m\n" })
    repo.git("checkout", "--quiet", "feature")
    try {
      repo.git("merge", "--quiet", "--no-edit", "main")
    } catch {
      // It conflicts: resolved next.
    }
    const resolved = commit(repo, "merge1 resolved", { "s.txt": "a\nRESOLVED\nc\n" })
    repo.git("checkout", "--quiet", "-b", "x")
    commit(repo, "x work", { "x.txt": "x\n" })
    repo.git("checkout", "--quiet", "feature")
    const f2 = commit(repo, "f2", { "f2.txt": "f2\n" })
    repo.git("merge", "--quiet", "--no-ff", "--no-edit", "-m", "merge x", "x")
    const mergeX = repo.git("rev-parse", "HEAD").trim()
    repo.git("checkout", "--quiet", "-b", "o1")
    const o1 = commit(repo, "o1", { "o1.txt": "1\n" })
    repo.git("checkout", "--quiet", "-b", "o2", "feature")
    commit(repo, "o2", { "o2.txt": "2\n" })
    repo.git("checkout", "--quiet", "feature")
    repo.git("merge", "--quiet", "--no-edit", "-m", "octopus", "o1", "o2")
    const octopus = repo.git("rev-parse", "HEAD").trim()
    const f1 = repo.git("rev-parse", `${resolved}^`).trim()
    return { f1, resolved, f2, mergeX, o1, octopus }
  }

  it("shows a branch of its own that a merge brought in as the merge's work, and main's as none", async ({
    repo,
  }) => {
    const { f1, resolved, f2, mergeX, o1, octopus } = featured(repo)
    const readers = reader()
    const read = await layersOf(readers, repo.root)
    const names = (id: string) =>
      read.change.layers.find((layer) => layer.id === id)!.files.map(({ path }) => path)

    expect(names(octopus)).toEqual(["o2.txt"])
    expect(names(o1)).toEqual(["o1.txt"])
    expect(names(mergeX)).toEqual(["x.txt"])
    expect(names(f2)).toEqual(["f2.txt"])
    expect(names(resolved)).toEqual(["s.txt"])
    expect(names(f1)).toEqual(["s.txt"])
    expect(read.change.layers.some((layer) => layer.firstParent)).toBe(false)

    // Ranges agree with the layers: their own work, whichever way they are cut.
    const files = (layers: string[]) => rangeFiles(readers, repo.root, layers)
    const touched = ["added:f2.txt", "modified:s.txt", "added:x.txt"]
    expect(await files([octopus, o1, mergeX, f2, resolved])).toEqual([
      "added:f2.txt",
      "added:o1.txt",
      "added:o2.txt",
      "modified:s.txt",
      "added:x.txt",
    ])
    expect(await files([mergeX, f2, resolved])).toEqual(touched)
    // Reaching the oldest layer is `main...HEAD` for the layers up to there.
    expect(await files([mergeX, f2, resolved, f1])).toEqual(touched)
    const whole = [octopus, o1, mergeX, f2, resolved, f1]
    expect(await files(whole)).toEqual(
      repo
        .git("diff", "--name-status", "main...HEAD")
        .trim()
        .split("\n")
        .map((each) => each.replace(/^M\t/, "modified:").replace(/^A\t/, "added:")),
    )
    // The lines of the whole are those of git's own diff.
    const range = await readers.range(repo.root, whole)
    if (!range.ok) throw new Error(range.reason)
    expect(range.range.files.map(({ path, added, removed }) => [path, added, removed])).toEqual(
      repo
        .git("diff", "--numstat", "main...HEAD")
        .trim()
        .split("\n")
        .map((each) => {
          const [a, r, path] = each.split("\t")
          return [path, Number(a), Number(r)]
        }),
    )
  })

  it("lists the layers of a merge with very many conflicts", async ({ repo }) => {
    branched(repo)
    const many = (text: string) =>
      Object.fromEntries(
        Array.from({ length: 400 }, (_, at) => [`dir/file_with_a_longish_name_${at}.txt`, text]),
      )
    commit(repo, "files", many("a\nb\nc\n"))
    repo.git("branch", "-f", "main")
    commit(repo, "feat", many("a\nFEAT\nc\n"))
    repo.git("checkout", "--quiet", "main")
    commit(repo, "main", many("a\nMAIN\nc\n"))
    repo.git("checkout", "--quiet", "feature")
    try {
      repo.git("merge", "--quiet", "--no-edit", "main")
    } catch {
      // Every file conflicts.
    }
    const resolved = commit(repo, "resolved", many("a\nBOTH\nc\n"))
    const read = await layersOf(reader(), repo.root)
    const layer = read.change.layers.find((each) => each.id === resolved)!
    expect(layer.files.length).toBeGreaterThan(0)
    expect(layer.added).toBe(400)
  })

  it("shows a merge against its first parent, flagged, where git can't merge in memory", async ({
    repo,
  }) => {
    const { f1, resolved, f2, mergeX, o1, octopus } = featured(repo)
    const readers = new LayerReader(() => undefined, 120, { mergeTree: false })
    opened.push(readers)
    const read = await layersOf(readers, repo.root)

    expect(
      read.change.layers.filter((layer) => layer.firstParent).map((layer) => layer.id),
    ).toEqual([octopus, mergeX, resolved])
    // Nothing fails: the merge of main shows what it brought in.
    expect(
      read.change.layers.find((layer) => layer.id === resolved)!.files.map(({ path }) => path),
    ).toEqual(["m.txt", "s.txt"])
    expect(await rangeFiles(readers, repo.root, [octopus, o1, mergeX, f2, resolved])).toEqual([
      "added:f2.txt",
      "added:m.txt",
      "added:o1.txt",
      "added:o2.txt",
      "modified:s.txt",
      "added:x.txt",
    ])
    expect(f1).toBeDefined()
  })
})

describe.skipIf(!hasGit)("the folders a reader makes", () => {
  const objectsOf = async (readers: LayerReader): Promise<string[]> => {
    const folder = await (readers as unknown as { folder: Promise<string> }).folder
    return readdirSync(folder)
      .filter((name) => name.endsWith("-objects"))
      .map((name) => join(folder, name))
  }
  const count = (path: string): number =>
    readdirSync(path, { withFileTypes: true }).reduce(
      (sum, entry) => sum + (entry.isDirectory() ? count(join(path, entry.name)) : 1),
      0,
    )

  it("empties a checkout's objects now and then, and goes on reading", async ({ repo }) => {
    branched(repo)
    commit(repo, "a", { "a.txt": "1\n" })
    const readers = new LayerReader(() => undefined, 3)
    opened.push(readers)
    const sizes: number[] = []
    for (let at = 0; at < 8; at += 1) {
      repo.write("a.txt", `edit ${at}\n`)
      // eslint-disable-next-line no-await-in-loop -- Each read follows its edit.
      const read = await layersOf(readers, repo.root)
      expect(read.change.layers[0]?.files.map(({ path }) => path)).toEqual(["a.txt"])
      // eslint-disable-next-line no-await-in-loop -- Counted after each read.
      const [folder] = await objectsOf(readers)
      sizes.push(count(folder!))
    }
    // It does not grow with the reads: it starts over every third.
    expect(Math.max(...sizes)).toBeLessThan(
      sizes.slice(0, 3).reduce((sum, size) => sum + size, 0) + 4,
    )
    expect(sizes[3]).toBeLessThan(sizes[2]!)
    const diff = await diffOf(readers, repo.root, "a.txt", ["uncommitted"])
    expect(diff.run?.after).toBe("edit 7\n")
  })

  it.skipIf(windows)(
    "ends the git runs under way when closed, and waits for no more than a moment",
    async ({ repo }) => {
      branched(repo)
      commit(repo, "a", { "a.txt": "1\n", ".gitattributes": "*.slow filter=slow\n" })
      repo.git("config", "filter.slow.clean", "sleep 20; cat")
      repo.write("x.slow", "x\n")
      const readers = new LayerReader(() => undefined)
      const pending = readers.read(repo.root)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const started = Date.now()
      await readers.close()

      expect(Date.now() - started).toBeLessThan(5_000)
      expect(await pending).toMatchObject({ ok: false })
      expect(
        (await (readers as unknown as { folder: Promise<string> | undefined }).folder) ?? "",
      ).toBe("")
    },
  )

  it("is gone when closed, after the read in flight", async ({ repo }) => {
    branched(repo)
    commit(repo, "a", { "a.txt": "1\n" })
    const readers = new LayerReader(() => undefined)
    const pending = readers.read(repo.root)
    let settled = false
    void pending.then(() => (settled = true))
    await new Promise((resolve) => setImmediate(resolve))
    await readers.close()
    expect(settled).toBe(true)
    const folder = await (readers as unknown as { folder: Promise<string> | undefined }).folder
    expect(folder).toBeUndefined()
    // Nothing is made for a read that comes after.
    expect(await readers.read(repo.root)).toMatchObject({ ok: false })
  })
})

describe.skipIf(!hasGit)("a repository in a folder named with the alternates separator", () => {
  it("is read, its files' sides too", async ({ repo }) => {
    const odd = join(join(repo.root, ".."), process.platform === "win32" ? "se;mi" : "co:lon")
    mkdirSync(odd)
    const run = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {
        cwd: odd,
        encoding: "utf8",
      })
    run("init", "--quiet", "-b", "main")
    writeFileSync(join(odd, "a.txt"), "one\ntwo\n")
    run("add", "-A")
    run("commit", "--quiet", "-m", "base")
    run("checkout", "--quiet", "-b", "feature")
    writeFileSync(join(odd, "a.txt"), "one\nTWO\n")
    writeFileSync(join(odd, "new.txt"), "new\n")
    const readers = reader()

    const read = await layersOf(readers, odd)
    expect(read.change.layers[0]?.files.map(({ path }) => path)).toEqual(["a.txt", "new.txt"])
    const diff = await diffOf(readers, odd, "a.txt", ["uncommitted"])
    expect(diff.run).toMatchObject({
      before: "one\ntwo\n",
      after: "one\nTWO\n",
    })
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
