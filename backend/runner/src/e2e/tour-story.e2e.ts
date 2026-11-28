import { afterAll, beforeAll } from "vitest"

import { nova } from "./agents/nova.js"
import { describe, e2e, supported } from "./fixture.js"
import { novaFromCache } from "./nova-cache.js"
import { folder, tell } from "./tour-story.js"

// Novadeck's tour story (see tour-story.ts), with Nova as the tour's agent, on the
// fake tour service (the fake model's, which gives the one ticket it accepts): the lead asks
// the person which game, then asks for a dev server the person approves, then opens a modeller
// and a builder;
// each teammate works in a worktree of its own and asks the person one thing; the person then
// keeps the project, and the team's work is committed on main. The model is a script that
// follows the briefs. All three agents run on Nova, which the runner unpacks from
// the e2e cache's copy of the pinned release.

const story = 360_000

let restorePi: (() => void) | undefined
beforeAll(async () => {
  restorePi = await novaFromCache()
})
afterAll(() => restorePi?.())

describe.skipIf(!supported)(nova.name, () => {
  const it = e2e.seeded({ trustedInHome: [folder] }, nova)

  it(
    "tells the tour's story: three agents make the game in worktrees, the person naming the world in their own words",
    { timeout: story },
    async ({ e2e: run }) => {
      await tell(run, nova, { words: "a penguin on a skateboard" })
    },
  )

  // As on every computer Novadeck has run agents on, the folder of agents' worktrees is
  // there already, and each shim gives it on, each harness its own way: the agents still
  // work in the tour's folder. Here the person picks an option.
  it(
    "tells the same story while the folder of agents' worktrees is there, the person picking an option",
    { timeout: story },
    async ({ e2e: run }) => {
      await tell(run, nova, { option: 1 }, { worktreesFolder: true })
    },
  )
})
