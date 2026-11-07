import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { delivered, replies, sends, own, prompted, start, turn } from "./scenarios.js"

// Agents asleep after Novadeck restarts, the same for every harness (see messaging.e2e.ts
// for the rule on parity). The deck has no window, as a Mac whose last one closed: the
// runner wakes a sleeper itself once a message wants it.
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("sleeps after a restart, and a message wakes the same session and is answered", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Remember the word heron", "Remembered."),
        sends("Ask moth for the word", "moth", "Which word did you remember?"),
        own((call) => (delivered(call, "fox") ? { text: "Heron, as asked." } : undefined)),
      )
      const t1 = await start(run, setup)
      await turn(t1, "Remember the word heron", "Remembered.")
      const before = run.deck.terminals.reportedSession(t1.id, setup.agent)
      expect(before).not.toBeNull()

      await run.deck.restart()

      // Saved with no shell, its agent asleep.
      const [asleep] = run.deck.terminals.list(run.deck.sessionId)
      expect(asleep).toMatchObject({
        id: t1.id,
        started: false,
        sleeping: true,
        restingAgent: setup.agent,
      })

      // A message from another agent is what wakes it: the runner starts the terminal itself.
      const sender = await start(run, setup)
      expect(sender.handle).toBe("fox")
      const calls = run.model.mark()
      await sender.submit("Ask moth for the word")

      await run.model.waitFor((call) => delivered(call, "fox"), {
        after: calls,
        timeoutMs: 120_000,
      })
      await sender.until("Heron, as asked.")
      const woke = run.deck.terminals.list(run.deck.sessionId).find((one) => one.id === t1.id)
      expect(woke).toMatchObject({ started: true, sleeping: false })
      // The same session, not a new one.
      expect(run.deck.terminals.reportedSession(t1.id, setup.agent)).toBe(before)
    })

    it("wakes when a window restores it, resuming the session it held", async ({ e2e: run }) => {
      run.model.use(replies("Remember the word heron", "Remembered."))
      const t1 = await start(run, setup)
      await turn(t1, "Remember the word heron", "Remembered.")
      const before = run.deck.terminals.reportedSession(t1.id, setup.agent)

      await run.deck.restart()
      expect(run.deck.terminals.list(run.deck.sessionId)[0]).toMatchObject({ sleeping: true })

      const resumed = await run.deck.restore(t1, { resume: setup.agent })
      await resumed.reached("ready", { timeoutMs: 60_000 })
      await prompted(resumed, setup)
      expect(resumed.summary()).toMatchObject({ sleeping: false, started: true })
      expect(run.deck.terminals.reportedSession(t1.id, setup.agent)).toBe(before)
    })
  })
}
