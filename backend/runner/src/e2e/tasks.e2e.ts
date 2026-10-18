import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { latest } from "./model/script.js"
import {
  closed,
  closes,
  deliveries,
  delivered,
  holds,
  opened,
  opens,
  own,
  result,
  ring,
  start,
  through,
} from "./scenarios.js"

// An agent starting another with a task (docs/agent-messaging.md, "Starting a task"), or
// closing another's terminal (docs/agent-workspace.md), the same for every harness (see
// messaging.e2e.ts for the rule on parity).
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("starts an agent another asked for, with the message as its first task", async ({
      e2e: run,
    }) => {
      const requests = run.deck.answerRequests()
      run.model.use(
        opens("Start a helper", setup.agent, "Count the files in src."),
        own((call) => (opened(call, "fox") ? { text: "Started fox." } : undefined)),
        own((call) => (delivered(call, "moth") ? { text: "Counting now." } : undefined)),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.submit("Start a helper")

      const t2 = await requests.next()
      expect(t2.handle).toBe("fox")
      // Its first prompt is the doorbell's line, given on its command line, and its hook
      // adds the task beside it: the first thing its model is asked.
      const task = await run.model.waitFor((call) => delivered(call, "moth"), { after: calls })
      expect(latest(task)).toMatch(ring)
      expect(deliveries(task)).toEqual([{ from: "moth", text: "Count the files in src." }])
      expect(task.turns.filter((one) => one.role !== "user")).toEqual([])
      await t2.until("Counting now.")
      await through(t2, [holds("moth", "fox", "delivered"), "settled"])
      // It came with the start, never with a ring.
      expect(t2.history().map((one) => one.delivery)).not.toContain("ringing")
      expect(t2.summary().agent).toBe(setup.agent)
      await t1.until("Started fox.")
      await t1.reached("settled", { after: mark })
    })

    it("closes another terminal it was asked to, ending the agent there and its shell", async ({
      e2e: run,
    }) => {
      run.model.use(
        closes("Close fox", "fox"),
        own((call) => (closed(call, "fox") ? { text: "Closed it." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      expect(t2.handle).toBe("fox")
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.submit("Close fox")

      const after = await run.model.waitFor((call) => closed(call, "fox"), { after: calls })
      expect(result(after)).toMatch(/Closed @fox(?: · [^,]+)?, which ran \S/)
      await t1.until("Closed it.")
      await t1.reached("settled", { after: mark })
      // Gone from the runner, as the person's close leaves it: its shell ended and forgotten.
      expect(() => run.deck.terminals.get(t2.id)).toThrow(
        expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
      )
      expect(run.deck.store.terminal(t2.id)).toBeUndefined()
    })
  })
}
