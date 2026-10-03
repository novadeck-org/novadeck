import { agy } from "./agents/agy.js"
import { claude } from "./agents/claude.js"
import { codex } from "./agents/codex.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import type { Call } from "./model/script.js"
import {
  deliveries,
  delivered,
  handing,
  holds,
  messages,
  own,
  prompted,
  replies,
  result,
  sends,
  sent,
  start,
  through,
  turn,
} from "./scenarios.js"

// The person leaving an agent for a different one in its terminal, across harnesses (see
// lifecycle.e2e.ts, where the same harness starts anew, and `handing` in scenarios.ts).
// Every harness leaves with `/exit`, typed at its prompt.

const order = [claude, codex, agy]

/** Whether the call is of t2's turn asking t1 once more. */
const again = (call: Call): boolean =>
  call.turns.some((one) => one.role === "user" && one.text.includes("Ask t1 once more"))

describe.skipIf(!supported)(order.map((setup) => setup.name).join(", "), () => {
  const it = e2e(...order)

  for (const [index, setup] of order.entries()) {
    const other = order[(index + 1) % order.length]!

    it(`makes ${setup.name}'s messages gone when ${other.name} starts in its terminal, telling the sender`, async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Remember the word heron", "Remembered."),
        sends("Ask t1 for the word", "t1", "Which word did you remember?"),
        sends("Ask t1 once more", "t1", "Any word at all?"),
        own((call) => (sent(call, "t1") ? { text: "Asked." } : undefined)),
        own((call) => (delivered(call, "t2") ? { text: "No word, another agent." } : undefined)),
      )
      const t1 = await handing(run, setup, other)
      await turn(t1, "Remember the word heron", "Remembered.")
      const t2 = await start(run, other)
      const mark = t1.mark()

      // The person types /exit; while it waits in the box, t2's message comes for the
      // session there. They submit it, and the agent leaves; its terminal's command then
      // starts the other.
      await t1.confirm("/exit", async () => {
        t1.press("/exit")
        await t1.reached("drafting", { after: mark })
        await t2.submit("Ask t1 for the word")
        await t1.reached(holds("t2", "t1", "queued"), { after: mark })
      })
      // The agent left, and the message for its session won't arrive; then the different
      // agent the terminal's command starts there is Ready (with no Unbound needed between,
      // as in lifecycle.e2e.ts).
      await through(t1, [holds("t2", "t1", "gone"), "ready"], {
        after: mark,
        timeoutMs: 60_000,
      })
      await prompted(t1, other)
      const [first] = messages(t1)
      expect(first).toMatchObject({ from: "t2", to: "t1", state: "gone" })
      const calls = run.model.mark()
      const from1 = t1.mark()

      await t2.submit("Ask t1 once more")

      const told = await run.model.waitFor((call) => sent(call, "t1") && again(call), {
        after: calls,
      })
      expect(result(told)).toContain(
        `Your earlier message ${first!.id} to t1 won't arrive: the agent session it was for ended there.`,
      )
      const rung = await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
      expect(rung.api).toBe(other.dialect.api)
      expect(deliveries(rung)).toEqual([{ from: "t2", text: "Any word at all?" }])
      await through(t1, ["ringing", "working", holds("t2", "t1", "delivered"), "settled"], {
        after: from1,
      })
      expect(t1.summary().agent).toBe(other.agent)
      expect(messages(t1).map((one) => [one.id === first!.id, one.state])).toEqual([
        [true, "gone"],
        [false, "delivered"],
      ])
    })
  }
})
