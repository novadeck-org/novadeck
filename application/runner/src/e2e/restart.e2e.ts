import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { latest } from "./model/script.js"
import {
  deliveries,
  delivered,
  holds,
  own,
  prompted,
  replies,
  ring,
  sends,
  start,
  through,
  turn,
} from "./scenarios.js"

// NovaDeck restarting under its agents, the same for every harness (see messaging.e2e.ts
// for the rule on parity).
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("resumes its session once the runner restarts, and is rung there for a message", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Remember the word heron", "Remembered."),
        sends("Ask t1 for the word", "t1", "Which word did you remember?"),
        own((call) => (delivered(call, "t2") ? { text: "Heron, as asked." } : undefined)),
      )
      const t1 = await start(run, setup)
      await turn(t1, "Remember the word heron", "Remembered.")
      const { sessionId } = await t1.detail()
      expect(sessionId).not.toBeNull()

      await run.deck.restart()

      // The new runner keeps the terminal as saved, with no shell, until a client restores
      // it, naming the agent that ran there.
      expect(
        run.deck.terminals.list(run.deck.sessionId).map((one) => [one.id, one.started]),
      ).toEqual([[t1.id, false]])
      const resumed = await run.deck.restore(t1, { resume: setup.agent })
      expect(resumed.handle).toBe("t1")
      await resumed.reached("ready", { timeoutMs: 60_000 })
      await prompted(resumed, setup)
      const t2 = await start(run, setup)
      const calls = run.model.mark()
      const mark = resumed.mark()

      await t2.submit("Ask t1 for the word")

      // The resumed t1, Ready, is rung, in the conversation it had before the restart.
      const rung = await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
      expect(latest(rung)).toMatch(ring)
      expect(deliveries(rung)).toEqual([{ from: "t2", text: "Which word did you remember?" }])
      expect(
        rung.turns.some(
          (one) => one.role === "user" && one.text.includes("Remember the word heron"),
        ),
      ).toBe(true)
      await resumed.until("Heron, as asked.")
      // Its ring is confirmed, so the turn it started ends Settled, not Drafting.
      await through(
        resumed,
        [
          holds("t2", "t1", "queued"),
          "ringing",
          "working",
          holds("t2", "t1", "delivered"),
          "settled",
        ],
        { after: mark },
      )
      expect((await resumed.detail()).sessionId).toBe(sessionId)
    })
  })
}
