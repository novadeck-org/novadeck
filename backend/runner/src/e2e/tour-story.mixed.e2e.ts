import type { AgentName } from "@novadeck/protocol"

import { agy } from "./agents/agy.js"
import { claude } from "./agents/claude.js"
import { codex } from "./agents/codex.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { folder, holdAtTrust, tell } from "./tour-story.js"

// Novadeck's tour story with every harness connected (see tour-story.e2e.ts): the first fixer
// runs on another harness than the lead, the first of Claude Code, Codex and Antigravity that
// isn't the lead's, on its own cheapest model; the person's own terminal runs the lead's.
// Files ending in `.mixed.e2e.ts` run only when every harness is selected.

const team = [claude, codex, agy]

// The first fixer's harness: the first that isn't the lead's.
const fixerOf = (lead: AgentName): AgentName => team.find(({ agent }) => agent !== lead)!.agent

for (const lead of team)
  describe.skipIf(!supported)(`${lead.name} leading a mixed team`, () => {
    const it = e2e.seeded({ trustedInHome: [folder] }, ...team)

    it("opens its first fixer on another harness", async ({ e2e: run }) => {
      const fixer = await tell(
        run,
        lead,
        team.map(({ agent }) => agent),
      )

      expect(fixer.agent).toBe(fixerOf(lead.agent))
    })

    // With the folder of agents' worktrees there, as tour-story.e2e.ts has it: each fixer
    // opens in the tour's folder, whichever harness leads.
    it("opens its first fixer in the tour's folder while the folder of agents' worktrees is there", async ({
      e2e: run,
    }) => {
      const fixer = await tell(
        run,
        lead,
        team.map(({ agent }) => agent),
        { worktreesFolder: true },
      )
      expect(fixer.agent).toBe(fixerOf(lead.agent))
    })
  })

// The first fixer's harness asks about the tour's folder, which the person hasn't trusted:
// Codex leads, so the fixer is Claude Code, and its terminal holds at that question, which
// the tour's coach points the person to.
describe.skipIf(!supported)("a mixed team whose fixer's harness asks about the folder", () => {
  const it = e2e.seeded({ folderTrusted: false, trustedInHome: [folder] }, ...team)

  it("holds the fixer's terminal at its startup screen, for the person to answer", async ({
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
