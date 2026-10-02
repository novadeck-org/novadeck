import { codex } from "./agents/codex.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { ringsAtReady } from "./known-gaps.js"
import { messages, sends, start, through } from "./scenarios.js"

// What only Codex needs beyond the shared scenarios (messaging.e2e.ts).

const it = e2e(codex)

describe.skipIf(!supported)("Codex", () => {
  // Pins a known gap (known-gaps.ts, `unrungAtFirstScreen`; docs/e2e-testing.md, "Known
  // gaps"): a Codex at its first screen, wide and tall enough to draw its logo, erases the
  // logo as anything lands in its input box, so the doorbell's test paste changes rows far
  // from its line and the ring fails: t2 goes from ringing to Unknown, never Working, with
  // the message still queued.
  // Once the doorbell rings such a Codex, this fails: assert that t2 is Working and the
  // message delivered, and take Codex out of that entry.
  it("can't ring a Codex still at its first screen", async ({ e2e: run }) => {
    expect(ringsAtReady(codex)).toBe(false)
    run.model.use(sends("Ask t2 for the code word", "t2", "What is the code word?"))
    const t1 = await start(run, codex)
    const t2 = await start(run, codex)

    const mark = t2.mark()

    await t1.submit("Ask t2 for the code word")

    const rung = await through(
      t2,
      ["ringing", (snapshot) => ["working", "unknown"].includes(snapshot.delivery)],
      { after: mark, timeoutMs: 60_000 },
    )
    expect(rung?.delivery).toBe("unknown")
    expect(messages(t2).map((one) => one.state)).toEqual(["queued"])
  })
})
