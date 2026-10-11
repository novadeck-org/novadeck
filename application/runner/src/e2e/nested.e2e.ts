import { setups } from "./agents/index.js"
import { describe, e2e, expect, gated, supported } from "./fixture.js"
import { asked, gate, latest, type Call } from "./model/script.js"
import {
  deliveries,
  delivered,
  holds,
  lacking,
  nestedRuns,
  own,
  result,
  ring,
  sends,
  sent,
  start,
} from "./scenarios.js"

// A nested agent inside an agent's turn, the same for every harness (see messaging.e2e.ts
// for the rule on parity): a root turn event is never one of a nested run of the harness
// (docs/agent-messaging.md, "What counts"), so its hooks get nothing.

// What the nested run is asked, which only its own conversation holds as a user's words:
// the agent's holds it only in the command it runs.
const asking = nestedRuns.inTurn
// Its answer, which reaches the agent only as its shell tool's output.
const word = "Kestrel-9 from the nested run"

/** Whether the call is the nested run's own, rather than an agent's in a terminal. */
const nested = (call: Call): boolean =>
  !call.side && call.turns.some((turn) => turn.role === "user" && turn.text.includes(asking))

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)
    const { shell } = setup

    gated(it, lacking(setup, "shell"))(
      "gives a nested run of the harness inside its turn nothing, and delivers at its own Stop",
      async ({ e2e: run }) => {
        // t1's turn starts the nested run only once t2's message waits for it.
        const waiting = gate()
        // Where t1's history stood as its agent read the nested run's output, so the run
        // has ended.
        let ran: number | undefined
        run.model.use(
          own((call) => (nested(call) ? { text: word } : undefined)),
          own(async (call) => {
            if (!asked(call, "Run the nested agent")) return undefined
            await waiting.opened
            return shell!.run(call, shell!.nested(asking))
          }),
          own((call) => {
            if (!(result(call) ?? "").includes(word)) return undefined
            ran ??= t1.mark()
            return { text: "The nested run said its word." }
          }),
          own((call) => (delivered(call, "t2") ? { text: "Got t2's word." } : undefined)),
          sends("Tell t1 the word", "t1", "The word is heron."),
          own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
        )
        const t1 = await start(run, setup)
        const t2 = await start(run, setup)
        expect([t1.handle, t2.handle]).toEqual(["t1", "t2"])
        const calls = run.model.mark()
        const mark = t1.mark()

        await t1.submit("Run the nested agent")
        await run.model.waitFor((call) => !call.side && asked(call, "Run the nested agent"), {
          after: calls,
        })
        await t1.reached("working", { after: mark })
        const { sessionId } = await t1.detail()
        expect(sessionId).not.toBeNull()
        // t2 sends t1 a message while t1 works: it waits for t1's turn to end.
        await t2.submit("Tell t1 the word")
        const queued = await t1.reached(holds("t2", "t1", "queued"), { after: mark })
        waiting.open()

        // The nested run really ran: its model call came, and its answer reached t1's agent
        // as its shell tool's output.
        const first = await run.model.waitFor(nested, { after: calls })
        expect(deliveries(first)).toEqual([])
        // Its shell tool waits for the command up to 10 s (Antigravity), 30 s (Codex) or
        // 2 min (Claude Code); a run past that would end the turn on the tool's "still
        // running", which this wait's failure then shows on screen.
        await t1.until("The nested run said its word.", 60_000)
        expect(ran).toBeDefined()

        // t1's own Stop then delivers the message, in t1's own conversation: a Stop
        // continuing the turn, never a ring, and nothing settled before it.
        const handed = await t1.reached(holds("t2", "t1", "delivered"), { after: queued.index })
        const before = t1
          .history()
          .slice(queued.index, handed.index + 1)
          .map((one) => one.delivery)
        expect(before).not.toContain("ringing")
        expect(before).not.toContain("settled")
        await t1.reached("settled", { after: handed.index })
        const got = await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
        expect(latest(got)).not.toMatch(ring)
        expect(nested(got)).toBe(false)
        expect(
          got.turns.some(
            (turn) => turn.role === "user" && turn.text.includes("Run the nested agent"),
          ),
        ).toBe(true)
        // The one message, which Claude Code's continuation quotes twice: as the Stop hook's
        // feedback and again as its blocking error (2.1.287).
        expect(new Set(deliveries(got).map((one) => JSON.stringify(one)))).toEqual(
          new Set([JSON.stringify({ from: "t2", text: "The word is heron." })]),
        )
        await t1.until("Got t2's word.")

        // Its hooks got nothing: no call of the nested run carried a message, and the
        // message waited, never leased, while t1 worked through the nested run.
        const all = run.model.calls.slice(calls).filter(nested)
        expect(all.length).toBeGreaterThan(0)
        expect(all.flatMap(deliveries)).toEqual([])
        const during = t1.history().slice(queued.index, ran)
        expect(during.map((one) => one.delivery)).toEqual(during.map(() => "working"))
        expect(during.map((one) => one.messages.map((message) => message.state))).toEqual(
          during.map(() => ["queued"]),
        )
        // t1's binding and session are as they were.
        expect((await t1.detail()).sessionId).toBe(sessionId)
        expect(t1.summary().agent).toBe(setup.agent)
      },
    )
  })
}
