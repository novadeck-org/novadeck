import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { start } from "./scenarios.js"
import { classified, unclassified } from "./tools.js"

// The tools each harness offers its model on a plain first turn, checked against the list
// of tools Novadeck has classified (tools.ts), the same for every harness (see
// messaging.e2e.ts for the rule on parity). A harness that adds a tool asking the person
// would otherwise ask where Novadeck never looks, as Codex's request_user_input_async did.
// Meant to run against the newest harnesses (NOVADECK_E2E_HARNESS=latest, the nightly) as
// much as the pinned.

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("offers only tools Novadeck has classified as asking or not", async ({ e2e: run }) => {
      const t = await start(run, setup)
      await t.submit("Say OK")
      await t.until("OK.")
      const first = run.model.calls.find((call) => !call.side)
      expect(first, "the agent's first model call").toBeDefined()
      const offered = first!.tools
      expect(offered.length, "the tools it offered").toBeGreaterThan(0)
      const strange = unclassified(setup.agent, offered)
      expect(
        strange,
        `${setup.name} offers tools Novadeck hasn't classified. Classify each in src/e2e/tools.ts, as asking the person or not; if it asks the person, Novadeck must handle it (show it in the Inbox) before it is classified as asking. All offered: ${offered.join(", ")}`,
      ).toEqual([])
      // The list says only what exists: a tool it names that no harness has offered in a
      // while is for a person to prune, never a failure, as versions differ.
      expect(classified(setup.agent).length).toBeGreaterThan(0)
    })
  })
}
