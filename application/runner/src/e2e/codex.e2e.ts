import { codex } from "./agents/codex.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { latest } from "./model/script.js"
import {
  deliveries,
  delivered,
  holds,
  messages,
  own,
  ring,
  sends,
  sent,
  start,
  through,
} from "./scenarios.js"

// What only Codex needs beyond the shared scenarios (messaging.e2e.ts).

const it = e2e(codex)

/** Ten rows in a row holding braille, as Codex draws its logo. */
const logo = /(?:^.*[⠀-⣿].*\n){10}/m

describe.skipIf(!supported)("Codex", () => {
  // Wide and tall enough, Codex draws a logo on its first screen while its box is empty,
  // and erases it as anything lands there: the doorbell's test paste changes rows far
  // from its line, which it accepts only as text vanishing whole (docs/agent-messaging.md,
  // "The doorbell").
  it("rings a Codex still at its first screen", async ({ e2e: run }) => {
    run.model.use(
      sends("Ask t2 for the code word", "t2", "What is the code word?"),
      own((call) => (sent(call, "t2") ? { text: "Asked." } : undefined)),
      own((call) => (delivered(call, "t1") ? { text: "Heron." } : undefined)),
    )
    const t1 = await start(run, codex)
    const t2 = await start(run, codex)
    // The case this covers: the logo shows as t2 is rung.
    await t2.until(logo)
    const calls = run.model.mark()
    const mark = t2.mark()

    await t1.submit("Ask t2 for the code word")

    await through(t2, ["ringing", "working"], { after: mark })
    const rung = await run.model.waitFor((call) => delivered(call, "t1"), { after: calls })
    expect(latest(rung)).toMatch(ring)
    expect(deliveries(rung)).toEqual([{ from: "t1", text: "What is the code word?" }])
    await t2.until("Heron.")
    await through(t2, [holds("t1", "t2", "delivered"), "settled"], { after: mark })
    expect(messages(t2).map((one) => one.state)).toEqual(["delivered"])
  })
})
