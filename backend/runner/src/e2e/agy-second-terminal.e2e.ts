import { agy } from "./agents/agy.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, gate } from "./model/script.js"
import { own, start } from "./scenarios.js"

// Antigravity 1.5.17's process, as it starts, resumes a conversation of its home that
// another process is running ("Resuming 1 conversation(s) interrupted by server restart"),
// cancelling that process's tool call, and runs it itself: its hooks, in the new terminal,
// then name the other terminal's conversation. That conversation stays the other's: the new
// terminal starts as any other, its agent not yet run, ready for its own first prompt.

describe.skipIf(!supported)("Antigravity", () => {
  const it = e2e(agy)

  it("starts a second terminal that is its own while the first is mid-turn", async ({
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

    const second = await start(run, agy)
    expect(second.summary().agentRan).toBe(false)
    hold.open()
    await first.until("First done.")

    await second.submit("Say two")
    await second.until("Second done.")
    // The screen shows a reply before the runner's summary names it: its turn ends by the Stop
    // hook and its words by a transcript read, each told to the deck after the screen is drawn.
    await Promise.all(
      (
        [
          [first, "First done."],
          [second, "Second done."],
        ] as const
      ).map(async ([terminal, reply]) => {
        await terminal.poll(
          () => terminal.summary().activity?.lastTurn?.reply ?? undefined,
          `the last turn's reply, ${reply}`,
        )
        expect(terminal.summary().activity?.lastTurn?.reply).toBe(reply)
      }),
    )
  })
})
