import { afterAll, beforeAll } from "vitest"

import { ownPi } from "./agents/own-pi.js"
import { describe, e2e, supported } from "./fixture.js"
import { ownPiFromCache } from "./own-pi-cache.js"
import { folder, tell } from "./tour-story.js"

// Novadeck's tour story (see tour-story.ts), with Novadeck's own pi as the tour's agent, on the
// fake tour service (the fake model's, which gives the one ticket it accepts): the lead pitches
// three games to the person, then asks for a dev server the person approves, then opens Core,
// World and Feel;
// each teammate works in a worktree of its own, tells the teammates before it what it exports and
// asks the person one thing while it works on; the person then keeps the project, and the team's
// work is committed on main. The model is a script that
// follows the briefs. All four agents run on Novadeck's own pi, which the runner unpacks from
// the e2e cache's copy of the pinned release.

const story = 360_000

let restorePi: (() => void) | undefined
beforeAll(async () => {
  restorePi = await ownPiFromCache()
})
afterAll(() => restorePi?.())

describe.skipIf(!supported)(ownPi.name, () => {
  const it = e2e.seeded({ trustedInHome: [folder] }, ownPi)

  it(
    "tells the tour's story: three agents make the game in worktrees, the person naming the game in their own words",
    { timeout: story },
    async ({ e2e: run }) => {
      await tell(run, ownPi, { words: "a penguin on a skateboard" })
    },
  )

  // As on every computer Novadeck has run agents on, the folder of agents' worktrees is
  // there already, and each shim gives it on, each harness its own way: the agents still
  // work in the tour's folder. Here the person picks an option.
  it(
    "tells the same story while the folder of agents' worktrees is there, the person picking an option",
    { timeout: story },
    async ({ e2e: run }) => {
      await tell(run, ownPi, { option: 1 }, { worktreesFolder: true })
    },
  )
})
