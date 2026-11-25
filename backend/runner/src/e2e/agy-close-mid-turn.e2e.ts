import { agy } from "./agents/agy.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, gate } from "./model/script.js"
import { own, start } from "./scenarios.js"

// Antigravity 1.5.17's process, as it starts, resumes every conversation of its home that
// looks interrupted, and a conversation whose process ends mid-turn does. A terminal the
// person closes while its agent works has the turn stopped first (`Harness.resumesInterrupted`),
// so the agent started next in the project is its own: ready for its first prompt, never busy
// with the turn that was closed. Before 1.5.17 nothing resumes, so this holds there too.

describe.skipIf(!supported)("Antigravity", () => {
  const it = e2e(agy)

  it("leaves no turn for the next agent when a terminal is closed mid-turn", async ({
    e2e: run,
  }) => {
    const hold = gate()
    run.model.use(
      own(async (call) => {
        if (!asked(call, "Hold on")) return undefined
        await hold.opened
        return { text: "First done." }
      }),
      own((call) => (asked(call, "Say two") ? { text: "Second done." } : undefined)),
    )
    const first = await start(run, agy)
    await first.submit("Hold on")
    await run.model.waitFor((call) => !call.side && asked(call, "Hold on"))

    await run.deck.terminals.close({ terminalId: first.id })
    const after = run.model.mark()

    const second = await start(run, agy)
    expect(second.summary().agentRan).toBe(false)
    await second.submit("Say two")
    await second.until("Second done.")
    hold.open()
    expect(
      run.model.calls.slice(after).filter((call) => !call.side && asked(call, "Hold on")),
    ).toEqual([])
  })
})
