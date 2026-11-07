import { harnesses } from "../harnesses/registry.js"
import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import {
  delivered,
  hibernated,
  hibernateMs,
  holds,
  replies,
  sends,
  own,
  prompted,
  start,
  turn,
} from "./scenarios.js"

// Agents asleep after Novadeck restarts, the same for every harness (see messaging.e2e.ts
// for the rule on parity). The deck has no window, as a Mac whose last one closed: the
// runner wakes a sleeper itself once a message wants it.
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("sleeps after a restart, and a message wakes the same session, whose model call carries its earlier conversation", async ({
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

      // The woken terminal answers moth's own screen, not the sender's, so the proof is the
      // model call that carried the message: in the conversation it held before the restart.
      const rung = await run.model.waitFor((call) => delivered(call, "fox"), {
        after: calls,
        timeoutMs: 120_000,
      })
      expect(
        rung.turns.some(
          (one) => one.role === "user" && one.text.includes("Remember the word heron"),
        ),
      ).toBe(true)
      await expect
        .poll(() => run.deck.terminals.list(run.deck.sessionId).find((one) => one.id === t1.id), {
          timeout: 30_000,
        })
        .toMatchObject({ started: true, sleeping: false })
      // The same session, not a new one.
      expect(run.deck.terminals.reportedSession(t1.id, setup.agent)).toBe(before)
    })

    it(
      "is stopped when idle, and a message wakes the same session and is answered",
      { timeout: hibernateMs + 180_000 },
      async ({ e2e: run }) => {
        run.model.use(
          replies("Remember the word heron", "Remembered."),
          sends("Ask moth for the word", "moth", "Which word did you remember?"),
          own((call) => (delivered(call, "fox") ? { text: "Heron, as asked." } : undefined)),
        )
        const t1 = await start(run, setup)
        await turn(t1, "Remember the word heron", "Remembered.")
        const before = run.deck.terminals.reportedSession(t1.id, setup.agent)
        expect(before).not.toBeNull()

        // Idle, it is stopped in place: asleep on its session, with no exit announced.
        await hibernated(run, t1, setup.agent)
        const [asleep] = run.deck.terminals.list(run.deck.sessionId)
        expect(asleep).toMatchObject({
          id: t1.id,
          started: false,
          sleeping: true,
          restingAgent: setup.agent,
          exit: null,
        })

        // A message from another agent wakes it: the same session, not a new one.
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
        expect(run.deck.terminals.reportedSession(t1.id, setup.agent)).toBe(before)
      },
    )

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

    it("stays asleep as it was when its session turns out to run elsewhere, and the message is gone", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Remember the word heron", "Remembered."),
        replies("Say hello", "Hello."),
        sends("Ask moth for the word", "moth", "Which word did you remember?"),
        own((call) => (delivered(call, "moth") ? { text: "Not asked." } : undefined)),
      )
      const t1 = await start(run, setup)
      await turn(t1, "Remember the word heron", "Remembered.")
      const before = run.deck.terminals.reportedSession(t1.id, setup.agent)
      expect(before).not.toBeNull()

      await run.deck.restart()
      expect(run.deck.terminals.list(run.deck.sessionId)[0]).toMatchObject({ sleeping: true })

      // The person runs the same session by hand in another terminal, so the sleeper's session
      // is no longer free to wake into.
      const command = harnesses[setup.agent].launch.resume!(before!).join(" ")
      const elsewhere = await run.deck.open(command)
      await elsewhere.reached("ready", { timeoutMs: 60_000 })
      await prompted(elsewhere, setup)
      // Codex binds at its first prompt, so every harness gets one.
      await turn(elsewhere, "Say hello", "Hello.")
      expect(run.deck.terminals.reportedSession(elsewhere.id, setup.agent)).toBe(before)

      const sender = await start(run, setup)
      const mark = sender.mark()
      await sender.submit("Ask moth for the word")
      await sender.reached(holds(sender.handle, "moth", "gone"), {
        after: mark,
        timeoutMs: 120_000,
      })

      // The wake never started: the row is as it was, asleep on the session it held.
      const kept = run.deck.terminals.list(run.deck.sessionId).find((one) => one.id === t1.id)
      expect(kept).toMatchObject({ started: false, sleeping: true, restingAgent: setup.agent })
      expect(run.deck.terminals.reportedSession(t1.id, setup.agent)).toBe(before)
    })
  })
}
