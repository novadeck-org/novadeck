/* eslint-disable no-await-in-loop -- Each attempt runs after the one before has settled. */
import { setTimeout as sleep } from "node:timers/promises"

import { escapeScreenMs, escapeVerdictMs } from "../harnesses/activity.js"
import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, gate } from "./model/script.js"
import { own, start } from "./scenarios.js"

// Exercise both observed boundaries and the live race between them. Fixed delays cannot
// guarantee which side wins on a busy machine, so only the boundary cases require a
// particular outcome. The simultaneous release still checks whichever outcome the TUI
// actually shows, including a Stop arriving after Escape.
const phases = ["key first", "together", "reply first"] as const

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("reads a turn that finished despite the Escape as completed with its reply, and one the Escape stopped as interrupted", async ({
      e2e: run,
    }) => {
      let held = gate()
      run.model.use(
        own(async (call) => {
          if (!asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Too late." }
        }),
      )
      let completed = 0
      let interrupted = 0
      for (const phase of phases) {
        held = gate()
        const t1 = await start(run, setup)
        const calls = run.model.mark()
        const mark = t1.mark()
        await t1.prompt("Hold on")
        await run.model.waitFor((call) => !call.side && asked(call, "Hold on"), { after: calls })
        await t1.reached("working", { after: mark })

        // What a client reads of the last turn, as often as the loop turns.
        const read: string[] = []
        const watching = setInterval(() => {
          const outcome = t1.summary().activity?.lastTurn?.outcome
          if (outcome && read.at(-1) !== outcome) read.push(outcome)
        }, 5)
        try {
          if (phase === "reply first") {
            held.open()
            await t1.until("Too late.")
            await t1.reached("settled", { after: mark })
            // A Stop can arrive while the TUI still takes Escape as interruption.
            // This boundary deliberately waits past that verdict window; together below
            // retains the live race without assuming a particular winner.
            await sleep(escapeVerdictMs + escapeScreenMs)
            await t1.settled()
            t1.press("\x1b")
          } else {
            t1.press("\x1b")
            if (phase === "key first")
              // The runner's interruption is provisional until the harness takes the key.
              await t1.until(setup.interrupted("Hold on"))
            held.open()
          }
          // The harness has had its say, and the runner the window to hear it.
          await sleep(escapeVerdictMs + escapeScreenMs + 1500)

          const shown = await t1.screen()
          const stopped = /nterrupted/.test(shown) || setup.interrupted("Hold on").test(shown)
          const activity = t1.summary().activity
          const why = `${phase}, read ${read.join(", ")}:\n${shown}`
          // Whether the chat shows the person's interruption, as each harness tells it.
          const noted = async () => (await t1.transcript()).some((item) => item.interrupted)
          expect(activity?.state, why).toBe("idle")
          if (shown.includes("Too late.") && !stopped) {
            completed += 1
            expect(phase, why).not.toBe("key first")
            expect(activity?.lastTurn, why).toMatchObject({
              outcome: "completed",
              reply: "Too late.",
            })
            expect(await noted(), why).toBe(false)
          } else {
            interrupted += 1
            expect(phase, why).not.toBe("reply first")
            expect(activity?.lastTurn?.outcome, why).toBe("interrupted")
            // Where the Escape ended the turn first, a Stop after it is not the end until the
            // harness has said it didn't take the key. (A Stop told before the key ended the
            // turn completed, and the harness's interruption after it replaces that: clients
            // hold a finish for `finishGraceMs` for it.)
            if (read[0] === "interrupted") expect(read, why).not.toContain("completed")
            if (phase === "key first")
              await t1.poll(
                async () => ((await noted()) ? true : undefined),
                `the chat to show the interruption (${why})`,
                10_000,
              )
          }
        } finally {
          clearInterval(watching)
          held.open()
          await run.deck.terminals.close({ terminalId: t1.id }).catch(() => {})
        }
      }
      expect(completed).toBeGreaterThan(0)
      expect(interrupted).toBeGreaterThan(0)
    })
  })
}
