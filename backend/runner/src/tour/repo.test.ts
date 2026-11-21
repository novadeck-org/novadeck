import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DomainError } from "../errors.js"
import { describe, expect, it } from "../test.js"
import { resetTourFolder } from "./folder.js"
import { commitSandbox, requireGit } from "./repo.js"

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
      await resetTourFolder(folder, { "split.js": "a\nb\n" })
      await withEnv({ HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, async () => {
        await commitSandbox(folder)
      })
      const log = (args: string[]) =>
        execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim()
      expect(log(["symbolic-ref", "HEAD"])).toBe("refs/heads/main")
      expect(log(["log", "--format=%an <%ae>|%s"])).toBe(
        "Novadeck tour <tour@novadeck.invalid>|Start the tour's repo",
      )
      expect(log(["ls-files"])).toBe("split.js")
      // The tour's files as written: line endings never converted.
      expect(await readFile(join(folder, "split.js"), "utf8")).toBe("a\nb\n")
      await expect(stat(join(home, "hook-ran"))).rejects.toThrow()
    },
  )
})
