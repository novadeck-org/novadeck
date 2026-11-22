import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { claude } from "./agents/claude.js"
import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { prompted } from "./scenarios.js"
import { folder, seedTour, tell } from "./tour-story.js"

// Novadeck's tour story (docs/tour.md), for each harness as the lead: it opens a fixer for bug 1
// on the brief's model and effort, which works in a worktree; the person's own terminal is
// taken as a second fixer (`tour.fixer`), which asks the person and works in a worktree too;
// both tell the lead, and both fixes show in one preview of split.js. The model is a script
// (tour-story.ts) that follows the briefs. Both fixers run on the lead's own harness.

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e.seeded({ trustedInHome: [folder] }, setup)

    it("leads two fixers to both bugs fixed in worktrees, the person starting the second and choosing its way", async ({
      e2e: run,
    }) => {
      const fixer = await tell(run, setup, [setup.agent])

      // The same harness, on its own cheapest model.
      expect(fixer.agent).toBe(setup.agent)
    })

    // As on every computer Novadeck has run agents on, the folder of agents' worktrees is
    // there already, and each shim gives it on, each harness its own way: the lead and its
    // fixers still work in the tour's folder.
    it("tells the same story while the folder of agents' worktrees is there", async ({
      e2e: run,
    }) => {
      const fixer = await tell(run, setup, [setup.agent], {
        worktreesFolder: true,
      })
      expect(fixer.agent).toBe(setup.agent)
    })
  })
}

// The tour folder's own Claude Code settings take a teammate, which a person may start with no
// launch flags, out of a plan mode the person's own settings start it in: project settings outrank user ones.
describe.skipIf(!supported)(
  "Claude Code in the tour's folder, its user settings in plan mode",
  () => {
    const it = e2e.seeded({ trustedInHome: [folder] }, claude)

    it("starts in accept-edits mode, as the folder's project settings say", async ({
      e2e: run,
    }) => {
      const config = join(run.sandbox.env.CLAUDE_CONFIG_DIR ?? "", "settings.json")
      const user = JSON.parse(await readFile(config, "utf8")) as { permissions?: object }
      await writeFile(
        config,
        JSON.stringify({ ...user, permissions: { ...user.permissions, defaultMode: "plan" } }),
      )
      await seedTour(run, ["claude"])
      const prepared = await run.deck.tour.prepare("claude")
      // As a teammate starts: the program alone, none of the lead's launch flags.
      const terminal = await run.deck.openAt(prepared.directory, "claude")
      await terminal.reached("ready", { timeoutMs: 60_000 })
      await prompted(terminal, claude)
      const shown = await terminal.screen()
      expect(shown).toMatch(/accept edits on/i)
      expect(shown).not.toMatch(/plan mode on/i)
    })
  },
)
