import { setups } from "./agents/index.js"
import { describe, e2e, supported } from "./fixture.js"
import { folder, tell } from "./tour-story.js"

// Novadeck's tour story (see tour-story.ts), for each harness as the tour's agent: the lead
// opens a sculptor and a score fixer and a dev server the person approves, the sculptor asks
// the person who the hero is, the person starts a cover artist beside them, and each works in
// a worktree of its own; the person then keeps the project. The model is a script that follows
// the briefs. All four agents run on the tour's harness.

const story = 360_000

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e.seeded({ trustedInHome: [folder] }, setup)

    it(
      "tells the tour's story: four agents make the game in worktrees, the person naming the hero in their own words",
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
