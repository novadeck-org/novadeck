import { setups } from "./agents/index.js"
import { describe, e2e, supported } from "./fixture.js"
import { folder, tell } from "./tour-story.js"

// Novadeck's tour story (see tour-story.ts), for each harness as the tour's agent: the lead asks
// the person which game, then asks for a dev server the person approves, then opens a modeller
// and a builder;
// each teammate works in a worktree of its own and asks the person one thing; the person then
// keeps the project, and the team's work is committed on main. The model is a script that
// follows the briefs. All three agents run on the tour's harness.

const story = 360_000

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e.seeded({ trustedInHome: [folder] }, setup)

    it(
      "tells the tour's story: three agents make the game in worktrees, the person naming the world in their own words",
      { timeout: story },
      async ({ e2e: run }) => {
        await tell(run, setup, { words: "a penguin on a skateboard" })
      },
    )

    // As on every computer Novadeck has run agents on, the folder of agents' worktrees is
    // there already, and each shim gives it on, each harness its own way: the agents still
    // work in the tour's folder. Here the person picks an option.
    it(
      "tells the same story while the folder of agents' worktrees is there, the person picking an option",
      { timeout: story },
      async ({ e2e: run }) => {
        await tell(run, setup, { option: 1 }, { worktreesFolder: true })
      },
    )
  })
}
