import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { worktreesRoot } from "../worktrees/root.js"
import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported, type E2E } from "./fixture.js"
import { asked, tool } from "./model/script.js"
import { own, result, start } from "./scenarios.js"

// A worktree's title (architecture/worktree-home.md): open_worktree requires one, and describe
// gives a worktree its caller owns another; both land in git config beside home, as
// `branch.<b>.novadeckTitle`. The same for every harness: a required parameter is one a
// harness could fail to pass on. The model here is a script, so this checks each harness offers
// both with the title and carries it to the runner, not what a real model writes there.

const branch = "feat/rounding"
const opened = "Checkout rounding fix"
const retitled = "Checkout rounding, half-even"

/** Git in the sandbox's project, with none of the developer's config. */
const git = (run: E2E, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd: run.sandbox.project,
      encoding: "utf8",
      env: { ...run.sandbox.env, GIT_CONFIG_NOSYSTEM: "1" },
    },
  ).trim()

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("opens a worktree with its title, and retitles it through describe", async ({
      e2e: run,
    }) => {
      git(run, "init", "--quiet", "-b", "main")
      writeFileSync(join(run.sandbox.project, "README.md"), "Shop\n")
      git(run, "add", "-A")
      git(run, "commit", "--quiet", "-m", "first")
      // Agent worktrees on, and their folder there, before the runner and its agents start: a
      // harness that keeps its first tool list sees the worktree tools only so.
      run.deck.store.settings.saveRunner({ worktrees: true })
      mkdirSync(worktreesRoot(run.sandbox.home), { recursive: true })
      await run.deck.restart()

      const path = (): string => run.deck.worktrees.all().find((row) => row.branch === branch)!.path
      let openSaid: string | undefined
      let describeSaid: string | undefined
      run.model.use(
        own((call) => {
          const open = tool(call, "open_worktree")
          return open && asked(call, "Open a worktree")
            ? { calls: [{ name: open, input: { branch, title: opened } }] }
            : undefined
        }),
        own((call) => {
          const text = result(call)
          if (!text?.includes("Opened the worktree")) return undefined
          openSaid = text
          return { text: "Opened." }
        }),
        own((call) => {
          const describeIt = tool(call, "describe")
          return describeIt && asked(call, "Retitle it")
            ? {
                calls: [
                  {
                    name: describeIt,
                    input: {
                      title: "Rounding",
                      summary: "Fixes how the checkout rounds a total.",
                      worktree: path(),
                      worktreeTitle: retitled,
                    },
                  },
                ],
              }
            : undefined
        }),
        own((call) => {
          const text = result(call)
          if (!text?.includes("Described this terminal")) return undefined
          describeSaid = text
          return { text: "Retitled." }
        }),
      )
      const t = await start(run, setup)
      await t.submit("Open a worktree")
      await t.until("Opened.")
      expect(openSaid).toContain(`on the new branch ${branch}`)
      expect(git(run, "config", "--get", `branch.${branch}.novadeckTitle`)).toBe(opened)

      await t.submit("Retitle it")
      await t.until("Retitled.")
      expect(describeSaid).toContain(`titled the worktree on ${branch} "${retitled}"`)
      expect(git(run, "config", "--get", `branch.${branch}.novadeckTitle`)).toBe(retitled)
    })
  })
}
