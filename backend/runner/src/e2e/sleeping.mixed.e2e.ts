import { agy } from "./agents/agy.js"
import { claude } from "./agents/claude.js"
import { codex } from "./agents/codex.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { delivered, own, replies, sends, start, turn } from "./scenarios.js"

// A sleeping agent woken across harnesses: every harness in one project, against one fake
// model. Files ending in `.mixed.e2e.ts` run only when every harness is selected, as in CI's
// mixed job. As in sleeping.e2e.ts, the deck has no window, so the runner wakes the sleeper
// itself once a message wants it.

/** Each harness leads the next one, which sleeps. */
const order = [claude, codex, agy]
const pairs = order.map((lead, index) => ({ lead, worker: order[(index + 1) % order.length]! }))

describe.skipIf(!supported)(order.map((setup) => setup.name).join(" → "), () => {
  const it = e2e(...order)

  for (const { lead, worker } of pairs)
    it(`${lead.name} messages a sleeping ${worker.name} worker, which wakes on its session and replies`, async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Remember the word heron", "Remembered."),
        sends("Ask moth for the word", "moth", "Which word did you remember?"),
        own((call) => (delivered(call, "fox") ? { text: "Heron, as asked." } : undefined)),
      )
      const sleeper = await start(run, worker)
      expect(sleeper.handle).toBe("moth")
      await turn(sleeper, "Remember the word heron", "Remembered.")
      const before = run.deck.terminals.reportedSession(sleeper.id, worker.agent)
      expect(before).not.toBeNull()

      await run.deck.restart()
      expect(run.deck.terminals.list(run.deck.sessionId)[0]).toMatchObject({
        id: sleeper.id,
        started: false,
        sleeping: true,
        restingAgent: worker.agent,
      })

      // The lead is of another harness: its message is what wakes the worker, the same session.
      const sender = await start(run, lead)
      expect(sender.handle).toBe("fox")
      const calls = run.model.mark()
      await sender.submit("Ask moth for the word")

      await run.model.waitFor((call) => delivered(call, "fox"), {
        after: calls,
        timeoutMs: 120_000,
      })
      await sender.until("Heron, as asked.")
      const woke = run.deck.terminals.list(run.deck.sessionId).find((one) => one.id === sleeper.id)
      expect(woke).toMatchObject({ started: true, sleeping: false })
      expect(run.deck.terminals.reportedSession(sleeper.id, worker.agent)).toBe(before)
    })
})
