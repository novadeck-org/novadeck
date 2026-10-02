import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { latest } from "./model/script.js"
import {
  deliveries,
  delivered,
  holds,
  opened,
  opens,
  own,
  ring,
  start,
  through,
} from "./scenarios.js"

// An agent starting another with a task (docs/agent-messaging.md, "Starting a task"), the
// same for every harness (see messaging.e2e.ts for the rule on parity).
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("starts an agent another asked for, with the message as its first task", async ({
      e2e: run,
    }) => {
      const requests = run.deck.answerRequests()
      run.model.use(
        opens("Start a helper", setup.agent, "Count the files in src."),
        own((call) => (opened(call, "t2") ? { text: "Started t2." } : undefined)),
        own((call) => (delivered(call, "t1") ? { text: "Counting now." } : undefined)),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.submit("Start a helper")

      const t2 = await requests.next()
      expect(t2.handle).toBe("t2")
      // Its first prompt is the doorbell's line, given on its command line, and its hook
      // adds the task beside it: the first thing its model is asked.
      const task = await run.model.waitFor((call) => delivered(call, "t1"), { after: calls })
      expect(latest(task)).toMatch(ring)
      expect(deliveries(task)).toEqual([{ from: "t1", text: "Count the files in src." }])
      expect(task.turns.filter((one) => one.role !== "user")).toEqual([])
      await t2.until("Counting now.")
      await through(t2, [holds("t1", "t2", "delivered"), "settled"])
      // It came with the start, never with a ring.
      expect(t2.history().map((one) => one.delivery)).not.toContain("ringing")
      expect(t2.summary().agent).toBe(setup.agent)
      await t1.until("Started t2.")
      await t1.reached("settled", { after: mark })
    })
  })
}
