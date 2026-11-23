import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DomainError } from "../errors.js"
import { describe, expect, it } from "../test.js"
import { keepTourFolder, resetTourFolder } from "./folder.js"
import { bringHome, commitSandbox, laySandbox, releaseSandbox, requireGit } from "./repo.js"

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
        "models/shapes.bin": "bytes",
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
        [".gitignore", "AGENTS.md", "models/shapes.bin", "src/main.js"].toSorted(),
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
    // With the seed's own .gitattributes, so a worktree's files are as committed on Windows too.
    await resetTourFolder(folder, {
      ".gitattributes": "* text=auto eol=lf\n",
      "AGENTS.md": "project\n",
      "src/main.js": "game\n",
    })
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

describe("bringing the team's work home", () => {
  const git = (folder: string, ...args: string[]) =>
    execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim()

  // Writes `text` to `path`, dated `seconds` past a fixed time, so which copy is newest is set.
  const dated = async (path: string, text: string, seconds: number): Promise<void> => {
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, text)
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, seconds))
    await utimes(path, at, at)
  }

  // The tour's folder, committed and laid as the tour readies it, with two teammates' worktrees.
  const team = async (resources: Resources) => {
    const root = await scratch(resources)
    const folder = join(root, "tour")
    await resetTourFolder(folder, {
      ".gitattributes": "* text=auto eol=lf\n",
      ".gitignore": "vendor/\n",
      "AGENTS.md": "project\n",
      "src/main.js": "placeholder\n",
      "vendor/lib.js": "lib\n",
    })
    await commitSandbox(folder)
    await laySandbox(folder, { "AGENTS.md": "sandbox\n", ".claude/settings.json": "{}\n" })
    const models = join(root, "models")
    const game = join(root, "game")
    git(folder, "worktree", "add", "-q", "-b", "models", models)
    git(folder, "worktree", "add", "-q", "-b", "game", game)
    return { folder, models, game }
  }

  it("commits on main what the dev server serves, the newest copy of each file", async ({
    resources,
  }) => {
    const { folder, models, game } = await team(resources)
    await dated(join(models, "models", "knight.gltf"), "knight\n", 1)
    await dated(join(game, "src", "main.js"), "game v1\n", 2)
    // Both changed the game: the newer copy is the one served.
    await dated(join(models, "src", "main.js"), "game v2\n", 3)
    await dated(join(game, "src", "play.js"), "play\n", 4)
    await bringHome(folder)
    expect(await readFile(join(folder, "models", "knight.gltf"), "utf8")).toBe("knight\n")
    expect(await readFile(join(folder, "src", "main.js"), "utf8")).toBe("game v2\n")
    expect(await readFile(join(folder, "src", "play.js"), "utf8")).toBe("play\n")
    expect(git(folder, "log", "-1", "--format=%s %an")).toBe("The team's game Novadeck tour")
    expect(git(folder, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
    // Nothing of the tour's own is committed, and the folder is clean.
    expect(git(folder, "show", "HEAD:AGENTS.md")).toBe("project")
    expect(git(folder, "ls-files")).not.toMatch(/\.claude|\.novadeck-tour|vendor/)
    expect(git(folder, "status", "--porcelain")).toBe("")
    // Each worktree holds that commit and nothing more: its work reads as merged.
    const main = git(folder, "rev-parse", "HEAD")
    for (const worktree of [models, game]) {
      expect(git(worktree, "rev-parse", "HEAD")).toBe(main)
      expect(git(worktree, "status", "--porcelain")).toBe("")
    }
  })

  it("keeps the folder's own change where it is the newer, and commits nothing where none", async ({
    resources,
  }) => {
    const { folder, game } = await team(resources)
    await dated(join(game, "src", "main.js"), "theirs\n", 1)
    await dated(join(folder, "src", "main.js"), "ours\n", 2)
    await bringHome(folder)
    expect(await readFile(join(folder, "src", "main.js"), "utf8")).toBe("ours\n")
    const commits = git(folder, "rev-list", "--count", "HEAD")
    await bringHome(folder)
    expect(git(folder, "rev-list", "--count", "HEAD")).toBe(commits)
  })

  it("does nothing where the folder is no repo", async ({ resources }) => {
    const folder = await scratch(resources)
    await bringHome(folder)
    expect(await stat(join(folder, ".git")).catch(() => undefined)).toBeUndefined()
  })
})
