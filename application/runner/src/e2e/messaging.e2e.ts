import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { gate, latest, tool } from "./model/script.js"
import {
  deliveries,
  delivered,
  holds,
  messages,
  own,
  replies,
  ring,
  sends,
  sent,
  start,
  through,
  turn,
} from "./scenarios.js"

// The same scenarios for every harness. Where one differs, it is a trait of its setup or
// a known gap (known-gaps.ts), never a check of which harness this is.
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("starts straight at its prompt, which NovaDeck sees as Ready", async ({ e2e: run }) => {
      // Ready is NovaDeck's word that the agent's own empty prompt shows, past any trust,
      // onboarding, sign-in, key, update or hooks screen, each harness telling it its own
      // way (docs/agent-messaging.md, "States").
      const t1 = await start(run, setup)

      // Only the screen shows that it is the harness's own first screen.
      await t1.until(setup.banner)
      // Nothing waits on the person, and a harness that starts its session as it starts
      // has bound it at Ready; the others bind at their first prompt.
      const detail = await t1.detail()
      expect(detail.requests).toEqual([])
      expect(detail.sessionId !== null).toBe(setup.bindsAtReady)
      expect(t1.summary().agent).toBe(setup.bindsAtReady ? setup.agent : null)
    })

    it("takes a prompt to the model and shows its reply, then ends its turn", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Say the word", "Pelican-7 says hello."))
      const t1 = await start(run, setup)

      await turn(t1, "Say the word", "Pelican-7 says hello.")

      const call = await run.model.waitFor(
        (one) => !one.side && latest(one).includes("Say the word"),
      )
      expect(call.api).toBe(setup.dialect.api)
      expect(tool(call, "send")).toBeDefined()
      // By its first prompt, every harness has bound its session.
      expect(t1.summary().agent).toBe(setup.agent)
    })

    it("rings an idle agent for a message, and its answer reaches the sender", async ({
      e2e: run,
    }) => {
      // The answer's path is fixed: t2's answer waits until t1's turn has ended, so the
      // doorbell brings it rather than t1's Stop.
      const answering = gate()
      run.model.use(
        sends("Ask t2 for its colour", "t2", "What is your colour?"),
        own((call) => (sent(call, "t2") ? { text: "Asked." } : undefined)),
        own(async (call) => {
          if (!delivered(call, "t1")) return undefined
          const reply = await sends("What is your colour?", "t1", "Mine is teal.")(call)
          if (reply) await answering.opened
          return reply
        }),
        own((call) => (delivered(call, "t2") ? { text: "t2 says teal." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      const calls = run.model.mark()
      const [from1, from2] = [t1.mark(), t2.mark()]

      await t1.submit("Ask t2 for its colour")

      // t2, Ready at its first screen, is rung: its prompt is the doorbell's line, and its
      // hook adds the message from t1 beside it.
      const rung = await run.model.waitFor((call) => delivered(call, "t1"), { after: calls })
      expect(latest(rung)).toMatch(ring)
      expect(deliveries(rung)).toEqual([{ from: "t1", text: "What is your colour?" }])
      await through(
        t2,
        [holds("t1", "t2", "queued"), "ringing", "working", holds("t1", "t2", "delivered")],
        { after: from2 },
      )
      // t1's turn ends; then t2 answers, and the doorbell rings t1.
      const done = await t1.reached("settled", { after: from1 })
      answering.open()
      await through(t1, ["ringing", "working"], { after: done.index })
      const answer = await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
      expect(deliveries(answer)).toEqual([{ from: "t2", text: "Mine is teal." }])
      await t1.until("t2 says teal.")
      await through(t1, [holds("t2", "t1", "delivered"), "settled"], { after: from1 })

      expect(messages(t1).map((one) => [one.from, one.to, one.state])).toEqual([
        ["t1", "t2", "delivered"],
        ["t2", "t1", "delivered"],
      ])
      expect(messages(t2)).toEqual(messages(t1))
    })

    it("reaches no model or login but the fake one", async ({ e2e: run }) => {
      run.model.use(own(() => ({ text: "Nothing left the machine." })))
      const t1 = await start(run, setup)

      await turn(t1, "Is this hermetic", "Nothing left the machine.")

      expect(run.model.foreign).toBe(0)
      expect(run.model.errors).toEqual([])
      // Every request to the fake model was one a dialect answered. The only others are
      // tunnels the proxy refused, to hosts the harness is known to try with no setting
      // that turns them off.
      const unexpected = run.model.strays.filter((stray) => {
        const [method, host = ""] = stray.split(" ")
        return method !== "CONNECT" || !setup.refused.includes(host)
      })
      expect(unexpected).toEqual([])
    })
  })
}
