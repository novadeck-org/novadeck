import type { AgentName } from "@novadeck/protocol"

import { waitsOn } from "./added-folders.js"
import { agy } from "./agents/agy.js"
import { claude } from "./agents/claude.js"
import { codex } from "./agents/codex.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { folder, holdAtTrust, tell } from "./tour-story.js"

// Novadeck's tour story with every harness connected (see tour-story.e2e.ts): the copywriter
// runs on the lead's harness and the designer on another, the first of Claude Code, Codex and
// Antigravity that isn't the lead's, each on its own cheapest model. Files ending in
// `.mixed.e2e.ts` run only when every harness is selected.

const team = [claude, codex, agy]

// The designer's harness: the first that isn't the lead's, whose own the copywriter runs on.
const designerOf = (lead: AgentName): AgentName => team.find(({ agent }) => agent !== lead)!.agent

for (const lead of team)
  describe.skipIf(!supported)(`${lead.name} leading a mixed team`, () => {
    const it = e2e.seeded({ trustedInHome: [folder] }, ...team)

    it("opens its designer on another harness", async ({ e2e: run }) => {
      const [writer, designer] = await tell(
        run,
        lead,
        team.map(({ agent }) => agent),
      )

      expect(writer.agent).toBe(lead.agent)
      expect(designer.agent).toBe(team.find(({ agent }) => agent !== lead.agent)!.agent)
    })

    // With the folder of agents' worktrees there, as tour-story.e2e.ts has it: each teammate
    // opens in the tour's folder, whichever harness leads.
    const waits = waitsOn([lead.agent, designerOf(lead.agent)], { readOnly: true })
    ;(waits === undefined ? it : it.skip)(
      `opens both teammates in the tour's folder while the folder of agents' worktrees is there${waits === undefined ? "" : `, skipped until: ${waits}`}`,
      async ({ e2e: run }) => {
        const [writer, designer] = await tell(
          run,
          lead,
          team.map(({ agent }) => agent),
          { worktreesFolder: true },
        )
        expect([writer.agent, designer.agent]).toEqual([lead.agent, designerOf(lead.agent)])
      },
    )
  })

// The designer's harness asks about the tour's folder, which the person hasn't trusted:
// Codex leads (it never asks of a folder that isn't git), so the designer is Claude Code, and
// its terminal holds at that question, which the tour's coach points the person to.
describe.skipIf(!supported)("a mixed team whose designer's harness asks about the folder", () => {
  const it = e2e.seeded({ folderTrusted: false, trustedInHome: [folder] }, ...team)

  it("holds the designer's terminal at its startup screen, for the person to answer", async ({
    e2e: run,
  }) => {
    const agent = await holdAtTrust(
      run,
      codex,
      team.map(({ agent: each }) => each),
    )
    expect(agent).toBe("claude")
  })
})
