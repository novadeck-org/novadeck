import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DomainError } from "../errors.js"
import { describe, expect, it } from "../test.js"
import { keepTourFolder, resetTourFolder } from "./folder.js"
import { commitSandbox, laySandbox, releaseSandbox, requireGit } from "./repo.js"

type Resources = { defer: (cleanup: () => Promise<void>) => void }

const scratch = async (resources: Resources) => {
  const root = await mkdtemp(join(tmpdir(), "novadeck-repo-"))
  resources.defer(() => rm(root, { recursive: true, force: true }))
  return root
}

// Runs `body` with these variables set in the process's environment, which the runner's git reads.
const withEnv = async (env: Record<string, string>, body: () => Promise<void>): Promise<void> => {
  const was = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  try {
    await body()
  } finally {
    for (const [key, value] of Object.entries(was))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
  }
}

const windows = process.platform === "win32"

describe("the tour's repo", () => {
  it.skipIf(windows)(
    "refuses, as git is missing, a git that is found but fails, as macOS' stub without its tools",
    async ({ resources }) => {
      const bin = await scratch(resources)
      await writeFile(join(bin, "git"), "#!/bin/sh\nexit 1\n")
      await chmod(join(bin, "git"), 0o755)
      await withEnv({ PATH: bin }, async () => {
        await expect(requireGit()).rejects.toThrow(/The tour needs git/)
        await expect(requireGit()).rejects.toBeInstanceOf(DomainError)
      })
    },
  )

  it.skipIf(windows)(
    "commits on main, as the tour, whatever the person's git settings say",
    async ({ resources }) => {
      const home = await scratch(resources)
      const hooks = join(home, "hooks")
      await mkdir(hooks)
      await writeFile(join(hooks, "post-commit"), `#!/bin/sh\ntouch ${join(home, "hook-ran")}\n`)
      await chmod(join(hooks, "post-commit"), 0o755)
      await writeFile(
        join(home, ".gitconfig"),
        `[core]\n\thooksPath = ${hooks}\n\tautocrlf = true\n\tsafecrlf = true\n[commit]\n\tgpgsign = true\n[init]\n\tdefaultBranch = trunk\n[user]\n\tname = Someone\n\temail = someone@example.com\n`,
      )
      const folder = join(await scratch(resources), "tour")
      await resetTourFolder(folder, { "src/score.js": "a\nb\n" })
      await withEnv({ HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, async () => {
        await commitSandbox(folder)
      })
      const log = (args: string[]) =>
        execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim()
      expect(log(["symbolic-ref", "HEAD"])).toBe("refs/heads/main")
      expect(log(["log", "--format=%an <%ae>|%s"])).toBe(
        "Novadeck tour <tour@novadeck.invalid>|Start the tour's repo",
      )
      expect(log(["ls-files"])).toBe("src/score.js")
      // The tour's files as written: line endings never converted.
      expect(await readFile(join(folder, "src", "score.js"), "utf8")).toBe("a\nb\n")
      await expect(stat(join(home, "hook-ran"))).rejects.toThrow()
    },
  )

  it.skipIf(windows)(
    "commits every file of the seed, whatever the person's global ignore file says, and not the vendor folder",
    async ({ resources }) => {
      const home = await scratch(resources)
      await writeFile(join(home, "ignore"), "*.bin\nAGENTS.md\n")
      await writeFile(
        join(home, ".gitconfig"),
        `[core]\n\texcludesFile = ${join(home, "ignore")}\n`,
      )
      const folder = join(await scratch(resources), "tour")
      await resetTourFolder(folder, {
        ".gitignore": "vendor/\n",
        "AGENTS.md": "note\n",
        "model/shapes.bin": "bytes",
        "vendor/lib.js": "big",
        "src/main.js": "game\n",
      })
      await withEnv(
        { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" },
        () => commitSandbox(folder),
      )
      const files = execFileSync("git", ["-C", folder, "ls-files"], { encoding: "utf8" })
        .trim()
        .split("\n")
      expect(files.toSorted()).toEqual(
        [".gitignore", "AGENTS.md", "model/shapes.bin", "src/main.js"].toSorted(),
      )
    },
  )
})

describe("the tour's rules over the committed project", () => {
  const git = (folder: string, ...args: string[]) =>
    execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim()

  // A folder as the tour readies it: the project committed, the sandbox's rules laid over it.
  const laid = async (resources: Resources) => {
    const folder = join(await scratch(resources), "tour")
    await resetTourFolder(folder, { "AGENTS.md": "project\n", "src/main.js": "game\n" })
    await commitSandbox(folder)
    await laySandbox(folder, {
      "AGENTS.md": "sandbox\n",
      ".claude/settings.json": '{"permissions":{}}\n',
    })
    return folder
  }

  it("keeps the project's note in the commit, the sandbox's on the disk, and the status clean", async ({
    resources,
  }) => {
    const folder = await laid(resources)
    expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe("sandbox\n")
    expect(git(folder, "show", "HEAD:AGENTS.md")).toBe("project")
    expect(git(folder, "status", "--porcelain")).toBe("")
    expect(git(folder, "ls-files")).not.toContain(".claude")
    expect(git(folder, "ls-files", "-v", "AGENTS.md")).toMatch(/^S /)
  })

  it("gives a worktree the project's note and none of the tour's settings", async ({
    resources,
  }) => {
    const folder = await laid(resources)
    const worktree = join(await scratch(resources), "work")
    git(folder, "worktree", "add", "-b", "hero", worktree)
    expect(await readFile(join(worktree, "AGENTS.md"), "utf8")).toBe("project\n")
    await expect(stat(join(worktree, ".claude"))).rejects.toThrow()
  })

  it("is released for the person: the note back, the bit cleared, the exclude lines gone", async ({
    resources,
  }) => {
    const folder = await laid(resources)
    await releaseSandbox(folder, "project\n")
    expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe("project\n")
    expect(git(folder, "ls-files", "-v", "AGENTS.md")).toMatch(/^H /)
    const exclude = await readFile(join(folder, ".git", "info", "exclude"), "utf8")
    expect(exclude).not.toContain(".claude/settings.json")
    expect(exclude).not.toContain(".novadeck-tour")
    // The folder's own side of keeping (`keepTourFolder`): the settings and the marker go.
    await keepTourFolder(folder)
    expect(git(folder, "status", "--porcelain")).toBe("")
    // And again, harmlessly.
    await releaseSandbox(folder, "project\n")
    expect(git(folder, "status", "--porcelain")).toBe("")
  })

  it("writes only the note where the folder is no repo", async ({ resources }) => {
    const folder = await scratch(resources)
    await releaseSandbox(folder, "project\n")
    expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe("project\n")
  })
})
