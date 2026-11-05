import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, tool } from "./model/script.js"
import { own, result, start, through } from "./scenarios.js"

// An agent's description of its own terminal (docs/agent-messaging.md, "Naming"): the
// title it gives names the terminal where nothing else has, by the terminal's own handle,
// and its summary is what other agents read. The same for every harness (see
// messaging.e2e.ts for the rule on parity). The model here is a script, so this checks
// that each harness offers `describe` with both fields and carries its answer, not what a
// real model makes of the notice that asks for it.

const title = "Checkout rounding fix"
const summary = "Fixes how the checkout rounds a total."

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("titles the terminal with the title its agent gave", async ({ e2e: run }) => {
      let answered: string | undefined
      let listed: string | undefined
      run.model.use(
        own((call) => {
          const describeIt = tool(call, "describe")
          return describeIt && asked(call, "Describe this terminal")
            ? { calls: [{ name: describeIt, input: { title, summary } }] }
            : undefined
        }),
        own((call) => {
          const text = result(call)
          if (!text?.includes("Described this terminal")) return undefined
          answered = text
          return { text: "Described." }
        }),
        // A second terminal lists its peers, where the summary shows.
        own((call) => {
          const agents = tool(call, "agents")
          if (agents && asked(call, "List the team"))
            return { calls: [{ name: agents, input: {} }] }
          const text = result(call)
          if (!text?.includes("You are @")) return undefined
          listed = text
          return { text: "Listed." }
        }),
      )
      const t1 = await start(run, setup)
      const mark = t1.mark()
      expect(t1.summary().titleSource).toEqual({ kind: "default" })

      await t1.submit("Describe this terminal")
      await t1.until("Described.")
      await through(t1, ["settled"], { after: mark })

      expect(answered).toContain("Described this terminal")
      expect(t1.summary()).toMatchObject({
        title,
        titleSource: { kind: "agent", by: t1.summary().handle },
      })

      const t2 = await start(run, setup)
      await t2.submit("List the team")
      await t2.until("Listed.")
      expect(listed).toContain(`title: ${title} (set by its own agent, not the user)`)
      expect(listed).toContain(`described by its agent: ${summary}`)
    })
  })
}
