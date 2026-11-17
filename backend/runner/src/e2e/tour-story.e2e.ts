import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { waitsOn } from "./added-folders.js"
import { claude } from "./agents/claude.js"
import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { prompted } from "./scenarios.js"
import { folder, seedTour, tell } from "./tour-story.js"

// Novadeck's tour story (docs/tour.md), for each harness as the lead: it opens a copywriter
// and a designer on the brief's model and effort, they describe themselves and send their
// parts, the copywriter asks the person in the Inbox, and the lead shows its card. The model
// is a script (tour-story.ts) that follows the folder's lead.md. Only the lead's own
// harness is connected here, so both teammates run on it; tour.mixed.e2e.ts has them differ.

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e.seeded({ trustedInHome: [folder] }, setup)

    it("leads a copywriter and a designer to a welcome card, the person choosing its tagline", async ({
      e2e: run,
    }) => {
      const [writer, designer] = await tell(run, setup, [setup.agent])

      // The same harness both times, on its own cheapest model.
      expect(writer.agent).toBe(setup.agent)
      expect(designer.agent).toBe(setup.agent)
    })

    // As on every computer Novadeck has run agents on, the folder of agents' worktrees is
    // there, and each shim passes it on as `--add-dir`: the lead and its teammates still work
    // in the tour's folder.
    const waits = waitsOn([setup.agent], { readOnly: true })
    ;(waits === undefined ? it : it.skip)(
      `tells the same story while the folder of agents' worktrees is there${waits === undefined ? "" : `, skipped until: ${waits}`}`,
      async ({ e2e: run }) => {
        const [writer, designer] = await tell(run, setup, [setup.agent], { worktreesFolder: true })
        expect([writer.agent, designer.agent]).toEqual([setup.agent, setup.agent])
      },
    )
  })
}

// The tour folder's own Claude Code settings take a teammate, which is given no launch flags,
// out of a plan mode the person's own settings start it in: project settings outrank user ones.
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
