import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { listFolder, maxFolderEntries } from "./folder.js"

const git = (directory: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: directory, stdio: "ignore" })

const project = (resources: { defer: (undo: () => void) => void }) => {
  const root = mkdtempSync(join(tmpdir(), "novadeck-folder-"))
  resources.defer(() => rmSync(root, { recursive: true, force: true }))
  return root
}

// A repository with a few files and folders, some of them ignored.
const repository = (resources: { defer: (undo: () => void) => void }) => {
  const root = project(resources)
  git(root, "init", "-q")
  writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\ndist\n")
  mkdirSync(join(root, "src", "dist"), { recursive: true })
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true })
  mkdirSync(join(root, "docs"))
  writeFileSync(join(root, "README.md"), "# Readme\n")
  writeFileSync(join(root, "debug.log"), "")
  writeFileSync(join(root, "src", "index.ts"), "")
  writeFileSync(join(root, "src", "dist", "out.js"), "")
  return root
}

describe("a project's folder", () => {
  it("lists folders first, then files, each by name, and never .git", async ({ resources }) => {
    const root = repository(resources)
    const { entries, truncated } = await listFolder(root, "")
    expect(truncated).toBe(false)
    expect(entries.map(({ name, folder }) => [name, folder])).toEqual([
      ["docs", true],
      ["node_modules", true],
      ["src", true],
      ["debug.log", false],
      [".gitignore", false],
      ["README.md", false],
    ])
  })

  it("marks what git ignores, folders by their directory patterns, and nothing else", async ({
    resources,
  }) => {
    const root = repository(resources)
    const ignored = async (folder: string) =>
      (await listFolder(root, folder)).entries.filter((entry) => entry.ignored).map((e) => e.name)
    expect(await ignored("")).toEqual(["node_modules", "debug.log"])
    expect(await ignored("src")).toEqual(["dist"])
    // Inside an ignored folder everything is ignored too.
    expect(await ignored("node_modules")).toEqual(["pkg"])
  })

  it("marks what a repository inside the project ignores, by its own rules", async ({
    resources,
  }) => {
    const root = repository(resources)
    const inner = join(root, "vendor")
    mkdirSync(join(inner, "build"), { recursive: true })
    git(inner, "init", "-q")
    writeFileSync(join(inner, ".gitignore"), "build/\n")
    writeFileSync(join(inner, "main.c"), "")
    const { entries } = await listFolder(root, "vendor")
    expect(entries.filter((entry) => entry.ignored).map(({ name }) => name)).toEqual(["build"])
  })

  it("reads a name that looks like git's pathspec magic as a name", async ({ resources }) => {
    const root = repository(resources)
    writeFileSync(join(root, ":!y"), "")
    writeFileSync(join(root, ":(icase)x"), "")
    const { entries } = await listFolder(root, "")
    expect(entries.filter((entry) => entry.ignored).map(({ name }) => name)).toEqual([
      "node_modules",
      "debug.log",
    ])
  })

  it("asks git about the project's repository, whatever GIT_DIR says", async ({ resources }) => {
    const root = repository(resources)
    const other = project(resources)
    git(other, "init", "-q")
    process.env.GIT_DIR = join(other, ".git")
    try {
      const { entries } = await listFolder(root, "")
      expect(entries.find((entry) => entry.name === "node_modules")?.ignored).toBe(true)
    } finally {
      delete process.env.GIT_DIR
    }
  })

  it("orders names as the Source panel does, so a cut listing drops the last ones", async ({
    resources,
  }) => {
    const root = project(resources)
    for (const name of ["b", "B", ".a", "c"]) writeFileSync(join(root, name), "")
    const { entries } = await listFolder(root, "")
    expect(entries.map(({ name }) => name)).toEqual([".a", "B", "b", "c"])
  })

  it("marks nothing ignored outside a repository", async ({ resources }) => {
    const root = project(resources)
    writeFileSync(join(root, ".gitignore"), "*.log\n")
    writeFileSync(join(root, "debug.log"), "")
    const { entries } = await listFolder(root, "")
    expect(entries.map(({ name, ignored }) => [name, ignored])).toEqual([
      ["debug.log", false],
      [".gitignore", false],
    ])
  })

  it("lists a folder inside a repository whose root is above the project", async ({
    resources,
  }) => {
    const root = repository(resources)
    expect((await listFolder(join(root, "src"), "")).entries).toEqual([
      { name: "dist", folder: true, ignored: true },
      { name: "index.ts", folder: false, ignored: false },
    ])
  })

  it("hides a .git that is a file, as a worktree has", async ({ resources }) => {
    const root = project(resources)
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n")
    writeFileSync(join(root, "a.txt"), "")
    expect((await listFolder(root, "")).entries.map(({ name }) => name)).toEqual(["a.txt"])
  })

  it.skipIf(process.platform === "win32")(
    "lists a link by what it points at, and refuses to read one that leaves the project",
    async ({ resources }) => {
      const root = repository(resources)
      const outside = project(resources)
      writeFileSync(join(outside, "secret.txt"), "")
      symlinkSync(join(outside, "secret.txt"), join(root, "secret-link"))
      symlinkSync(outside, join(root, "out"))
      symlinkSync(join(root, "docs"), join(root, "in"))
      symlinkSync(join(root, "missing"), join(root, "dangling"))
      const { entries } = await listFolder(root, "")
      const named = (name: string) => entries.find((entry) => entry.name === name)
      expect(named("out")).toMatchObject({ folder: true })
      expect(named("in")).toMatchObject({ folder: true })
      expect(named("secret-link")).toMatchObject({ folder: false })
      expect(named("dangling")).toMatchObject({ folder: false })
      // A link in the way doesn't stop git saying what it ignores.
      expect(named("node_modules")).toMatchObject({ ignored: true })
      await expect(listFolder(root, "out")).rejects.toMatchObject({ code: "INVALID_DIRECTORY" })
      await expect(listFolder(root, "in")).resolves.toEqual({ entries: [], truncated: false })
    },
  )

  it("refuses paths that are not folders inside the project", async ({ resources }) => {
    const root = repository(resources)
    const refused = ["..", "src/..", "../x", "/etc", "src//dist", "src/", "./src", "src\\dist"]
    refused.push("src\0", "missing", "README.md")
    await Promise.all(
      refused.map((folder) =>
        expect(listFolder(root, folder), folder).rejects.toMatchObject({
          code: "INVALID_DIRECTORY",
        }),
      ),
    )
    await expect(listFolder(join(root, "gone"), "")).rejects.toMatchObject({
      code: "INVALID_DIRECTORY",
    })
  })

  it("lists no more than it may, and says so", async ({ resources }) => {
    const root = project(resources)
    for (let index = 0; index < maxFolderEntries + 5; index++)
      writeFileSync(join(root, `f${String(index).padStart(5, "0")}`), "")
    const { entries, truncated } = await listFolder(root, "")
    expect(truncated).toBe(true)
    expect(entries).toHaveLength(maxFolderEntries)
    expect(entries[0]!.name).toBe("f00000")
  })
})
