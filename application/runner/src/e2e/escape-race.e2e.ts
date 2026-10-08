/* eslint-disable no-await-in-loop -- Each attempt runs after the one before has settled. */
import { setTimeout as sleep } from "node:timers/promises"

import { escapeVerdictMs } from "../harnesses/activity.js"
import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, gate } from "./model/script.js"
import { own, start } from "./scenarios.js"

// A Stop can lose to the reply it races: a harness that had the model's reply before it
// took the Escape finishes its turn all the same, and may fire its Stop even where it took
// the key just after (docs/harness-coverage.md, "Escape against a reply on its way"). The
// runner reads the turn as the harness ended it: completed, with that reply as `lastTurn`,
// where the reply won, interrupted where the key did, and never completed for a moment
// before it says interrupted (that moment is a "t1 is done" notification). Which wins is the
// harness's, so each attempt presses a raw Escape as a held reply is let go, `lead` ms
// before it, until one is lost; every attempt's turn must read as the screen shows it ended.
// A lead that lands the key in the reply's window loses it the most often (probed 2026-10-07,
// docs/harness-coverage.md): Claude Code's takes it just after the reply most times, Codex's
// takes it too, though its Stop fires first, and 200 ms ahead its reply wins, the Stop told
// before the key; Antigravity's reply wins the key let go together with it, the Stop told after.

const attempts = 12
const leads: { readonly [agent: string]: readonly number[] } = {
  claude: [20],
  codex: [20, 200],
  agy: [0],
}

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
      let lost = 0
      for (let attempt = 1; attempt <= attempts && lost === 0; attempt += 1) {
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
        const ahead = leads[setup.agent]![(attempt - 1) % leads[setup.agent]!.length]!
        if (ahead > 0) {
          held.open()
          await sleep(ahead)
        }
        t1.press("\x1b")
        held.open()
        // The harness has had its say, and the runner the window to hear it.
        await sleep(escapeVerdictMs + 1500)
        clearInterval(watching)

        const shown = await t1.screen()
        const stopped = /nterrupted/.test(shown) || setup.interrupted("Hold on").test(shown)
        const activity = t1.summary().activity
        const why = `attempt ${attempt}, lead ${ahead} ms, read ${read.join(", ")}:\n${shown}`
        expect(activity?.state, why).toBe("idle")
        if (shown.includes("Too late.") && !stopped) {
          lost += 1
          expect(activity?.lastTurn, why).toMatchObject({
            outcome: "completed",
            reply: "Too late.",
          })
        } else {
          expect(activity?.lastTurn?.outcome, why).toBe("interrupted")
          // Where the Escape ended the turn first, a Stop after it is not the end until the
          // harness has said it didn't take the key. (A Stop told before the key ended the
          // turn completed, and the harness's interruption after it replaces that: clients
          // hold a finish for `finishGraceMs` for it.)
          if (read[0] === "interrupted") expect(read, why).not.toContain("completed")
        }
        await run.deck.terminals.close({ terminalId: t1.id }, "e2e").catch(() => {})
      }
      expect(lost, `the reply won the race in none of ${attempts} attempts`).toBeGreaterThan(0)
    })
  })
}
