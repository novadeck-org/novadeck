import { agy } from "./agents/agy.js"
import { claude } from "./agents/claude.js"
import { codex } from "./agents/codex.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { gate } from "./model/script.js"
import {
  deliveries,
  delivered,
  holds,
  messages,
  own,
  sends,
  sent,
  start,
  through,
} from "./scenarios.js"

// Messaging across harnesses: every harness in one project, against one fake model. Files
// ending in `.mixed.e2e.ts` run only when every harness is selected, as in CI's mixed job.
// As in messaging.e2e.ts, where a harness differs it is a known gap (known-gaps.ts), never
// a check of which harness this is.

/** The ring's order: t1 sends to t2, each to the next, and the last back to t1. */
const order = [claude, codex, agy]
const handle = (index: number) => `t${index + 1}`
const after = (index: number) => (index + 1) % order.length
const passed = (index: number) => `Ring from ${handle(index)}.`

describe.skipIf(!supported)(order.map((setup) => setup.name).join(" → "), () => {
  const it = e2e(...order)

  it("passes a message round a ring of every harness, each rung for it", async ({ e2e: run }) => {
    const last = order.length - 1
    // How the ring's last message reaches t1 is fixed, as in the round trip: it waits until
    // t1's turn has ended, so the doorbell brings it rather than t1's Stop.
    const closing = gate()
    run.model.use(
      ...order.flatMap((_, index) => {
        const to = handle(after(index))
        const asked = index === 0 ? "Start the ring" : passed(index - 1)
        const send = sends(asked, to, passed(index))
        return [
          index === last
            ? own(async (call) => {
                const reply = await send(call)
                if (reply) await closing.opened
                return reply
              })
            : send,
          own((call) => (sent(call, to) ? { text: `Passed to ${to}.` } : undefined)),
        ]
      }),
      own((call) => (delivered(call, handle(last)) ? { text: "The ring is closed." } : undefined)),
    )
    const terminals = []
    for (const setup of order)
      // eslint-disable-next-line no-await-in-loop -- Opened in order, so each takes its handle.
      terminals.push(await start(run, setup))
    const calls = run.model.mark()
    const marks = terminals.map((terminal) => terminal.mark())
    const t1 = terminals[0]!

    await t1.submit("Start the ring")

    // Each recipient after t1, Ready at its first screen, is rung, and its model reads the
    // message from the one before it.
    for (let index = 0; index < last; index += 1) {
      const to = after(index)
      // eslint-disable-next-line no-await-in-loop -- Hop by hop, in the ring's order.
      const call = await run.model.waitFor((one) => delivered(one, handle(index)), {
        after: calls,
      })
      expect(deliveries(call)).toEqual([{ from: handle(index), text: passed(index) }])
      // eslint-disable-next-line no-await-in-loop -- As above.
      await through(
        terminals[to]!,
        [
          holds(handle(index), handle(to), "queued"),
          "ringing",
          "working",
          holds(handle(index), handle(to), "delivered"),
        ],
        { after: marks[to]! },
      )
    }
    // t1's turn ends; then the last sends, and the doorbell rings t1.
    const done = await t1.reached("settled", { after: marks[0]! })
    closing.open()
    await through(t1, ["ringing", "working"], { after: done.index })
    const back = await run.model.waitFor((one) => delivered(one, handle(last)), { after: calls })
    expect(deliveries(back)).toEqual([{ from: handle(last), text: passed(last) }])
    await t1.until("The ring is closed.")
    await t1.reached(holds(handle(last), "t1", "delivered"), { after: marks[0]! })

    const states = messages(t1).map((one) => `${one.from} → ${one.to} ${one.state}`)
    expect(states.toSorted()).toEqual(
      [`t1 → t2 delivered`, `${handle(last)} → t1 delivered`].toSorted(),
    )
  })
})
