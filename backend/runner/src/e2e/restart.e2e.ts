import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, latest, tool, type Call } from "./model/script.js"
import {
  deliveries,
  delivered,
  holds,
  own,
  prompted,
  replies,
  result,
  ring,
  sends,
  sent,
  start,
  through,
  turn,
  wrappers,
  pointsBack,
} from "./scenarios.js"

// Novadeck restarting under its agents, the same for every harness (see messaging.e2e.ts
// for the rule on parity).
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("points a session resumed after a restart to the rules note it was given before", async ({
      e2e: run,
    }) => {
      run.model.use(
        sends("Ask moth for the word", "moth", "Which word did you remember?"),
        own((call) =>
          !call.side && ring.test(latest(call)) && deliveries(call).length > 0
            ? { text: "Heron, as asked." }
            : undefined,
        ),
        own((call) => (sent(call, "moth") ? { text: "Asked." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      const before = run.model.mark()
      await t2.submit("Ask moth for the word")
      await run.model.waitFor((call) => delivered(call, "fox"), { after: before })
      await t1.until("Heron, as asked.")
      await t1.reached("settled")

      await run.deck.restart()
      const resumed = await run.deck.restore(t1, { resume: setup.agent })
      await resumed.reached("ready", { timeoutMs: 60_000 })
      await prompted(resumed, setup)
      const t3 = await start(run, setup)
      const calls = run.model.mark()
      await t3.submit("Ask moth for the word")

      // Where the harness keeps what its hooks print, its conversation holds the first
      // delivery with the note in full, and this one only points to it; elsewhere the
      // first is gone, and this one carries the note in full.
      const rung = await run.model.waitFor(
        (call) => !call.side && ring.test(latest(call)) && deliveries(call).length > 0,
        { after: calls },
      )
      expect(wrappers(rung).map(pointsBack)).toEqual(setup.keepsHookText ? [false, true] : [false])
      await resumed.until("Heron, as asked.")
    })

    it("resumes its session once the runner restarts, and is rung there for a message", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Remember the word heron", "Remembered."),
        sends("Ask moth for the word", "moth", "Which word did you remember?"),
        own((call) => (delivered(call, "fox") ? { text: "Heron, as asked." } : undefined)),
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
      expect(resumed.handle).toBe("moth")
      await resumed.reached("ready", { timeoutMs: 60_000 })
      await prompted(resumed, setup)
      const t2 = await start(run, setup)
      const calls = run.model.mark()
      const mark = resumed.mark()

      await t2.submit("Ask moth for the word")

      // The resumed t1, Ready, is rung, in the conversation it had before the restart.
      const rung = await run.model.waitFor((call) => delivered(call, "fox"), { after: calls })
      expect(latest(rung)).toMatch(ring)
      expect(deliveries(rung)).toEqual([{ from: "fox", text: "Which word did you remember?" }])
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
          holds("fox", "moth", "queued"),
          "ringing",
          "working",
          holds("fox", "moth", "delivered"),
          "settled",
        ],
        { after: mark },
      )
      expect((await resumed.detail()).sessionId).toBe(sessionId)
    })

    it("still knows after a restart that the person gave a peer more to do after its done", async ({
      e2e: run,
    }) => {
      const named = (call: Call, name: string): string => {
        const found = [call, ...run.model.calls].map((one) => tool(one, name)).find(Boolean)
        if (!found) throw new Error(`Novadeck's ${name} tool is missing`)
        return found
      }
      const listings: string[] = []
      run.model.use(
        own((call) => {
          if (asked(call, "Finish up"))
            return {
              calls: [
                {
                  name: named(call, "done"),
                  input: { subject: "Fixed the login bug", body: "All green." },
                },
              ],
            }
          if (/Report [a-f0-9-]+ is in the user's Inbox/.test(result(call) ?? ""))
            return { text: "Reported it done." }
          if (asked(call, "Look around"))
            return { calls: [{ name: named(call, "agents"), input: {} }] }
          const listing = result(call)
          if (listing?.includes("Other terminals in this project and session")) {
            listings.push(listing)
            return { text: "Looked." }
          }
          return undefined
        }),
        replies("Next task", "On the next task."),
      )
      const t1 = await start(run, setup)
      await turn(t1, "Finish up", "Reported it done.")
      await turn(t1, "Next task", "On the next task.")

      await run.deck.restart()

      const resumed = await run.deck.restore(t1, { resume: setup.agent })
      await resumed.reached("ready", { timeoutMs: 60_000 })
      await prompted(resumed, setup)
      const t2 = await start(run, setup)
      await turn(t2, "Look around", "Looked.")
      // The person's prompt after the done is kept with the terminal: never a stale done.
      expect(listings[0]).not.toContain("reported done")
      // A harness that binds its resumed session at its prompt shows its reports at once;
      // the others only once their next prompt binds it.
      if (setup.bindsAtReady)
        expect(listings[0]).toMatch(/\n {2}latest update [^:\n]+: Fixed the login bug\n?/)
    })

    it("returns a message leased to its hook to queued when the runner restarts", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Remember the word heron", "Remembered."),
        sends("Ask fox for its colour", "fox", "What is your colour?"),
        own((call) => (sent(call, "fox") ? { text: "Asked." } : undefined)),
        own((call) => (delivered(call, "moth") ? { text: "Mine is teal." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      // A turn first, so every harness has saved t2's session for its resume.
      await turn(t2, "Remember the word heron", "Remembered.")
      const { sessionId } = await t2.detail()
      const from2 = t2.mark()
      // The runner stops as soon as t2's ring's hook has the message leased, before its
      // acknowledgement can be heard: the listing that shows the lease comes in the tick
      // the runner leased it (its watches coalesce changes with setImmediate), and the
      // restart ends every lease at once, while the hook still has to read its answer,
      // print it and connect again to acknowledge.
      const restarted = t2
        .reached(holds("moth", "fox", "leased"), { after: from2 })
        .then(() => run.deck.restart())

      await t1.submit("Ask fox for its colour")
      await restarted

      // The new runner holds the message queued again, for the session t2's ring bound,
      // as t2's first listing there shows; resumed in that session, t2 is rung for it again.
      const calls = run.model.mark()
      const resumed = await run.deck.restore(t2, { resume: setup.agent })
      const [first] = resumed.history()
      expect(first?.messages.map((one) => [one.from, one.to, one.state])).toEqual([
        ["moth", "fox", "queued"],
      ])
      await through(resumed, ["ready", "ringing", "working", holds("moth", "fox", "delivered")], {
        timeoutMs: 60_000,
      })
      // At least once: the ring's hook may have printed it before the runner stopped, its
      // acknowledgement lost, and the agent then holds it twice, as the same message.
      const rung = await run.model.waitFor((call) => delivered(call, "moth"), { after: calls })
      const once = { from: "moth", text: "What is your colour?" }
      expect([[once], [once, once]]).toContainEqual(deliveries(rung))
      await resumed.until("Mine is teal.")
      expect((await resumed.detail()).sessionId).toBe(sessionId)
    })
  })
}
