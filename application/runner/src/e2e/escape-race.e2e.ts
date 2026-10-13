/* eslint-disable no-await-in-loop -- Each attempt runs after the one before has settled. */
import { setTimeout as sleep } from "node:timers/promises"

import { escapeScreenMs, escapeVerdictMs } from "../harnesses/activity.js"
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
// How long before the key a turn's end still counts as racing it: Codex's Stop, the
// earliest of the three, came up to 200 ms ahead of a key its reply beat (probed
// 2026-10-07), so 300 keeps that with room, where a turn over half a second before the
// key had plainly ended. It is the test's own measure of a race, not the runner's: how
// long the runner waits for a verdict (`escapeVerdictMs`) has no part in it.
const raceMs = 300
// On Windows the key won every attempt with Linux's leads, and Codex's with leads up to
// 500 ms, while with a second or more its turn had ended before the key (probed
// 2026-10-09 and 2026-10-11): longer ones are tried there, Codex's between the two. A
// machine where Codex ends its turn far sooner may see every attempt
// end before the key; the test then fails saying so, with each lead and how it went.
const leads: { readonly [agent: string]: readonly number[] } =
  process.platform === "win32"
    ? { claude: [20, 200, 500], codex: [550, 650, 750, 850, 950], agy: [0, 200, 500] }
    : { claude: [20], codex: [20, 200], agy: [0] }

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
      // Each attempt's lead and how it went: the reply won a race only where the turn ended
      // at most `raceMs` before the key, or after it, not long before as a lead long enough
      // lets it (Codex's Stop comes just before the key whenever its reply wins).
      const tried: string[] = []
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
        // When the turn first read as over.
        let endedAt: number | undefined
        const watching = setInterval(() => {
          const outcome = t1.summary().activity?.lastTurn?.outcome
          if (outcome && read.at(-1) !== outcome) read.push(outcome)
          if (outcome) endedAt ??= Date.now()
        }, 5)
        const ahead = leads[setup.agent]![(attempt - 1) % leads[setup.agent]!.length]!
        if (ahead > 0) {
          held.open()
          await sleep(ahead)
        }
        // Whether the turn had ended well before the key: then the reply raced nothing.
        const ended = endedAt !== undefined && Date.now() - endedAt > raceMs
        t1.press("\x1b")
        held.open()
        // The harness has had its say, and the runner the window to hear it.
        await sleep(escapeVerdictMs + escapeScreenMs + 1500)
        clearInterval(watching)

        const shown = await t1.screen()
        const stopped = /nterrupted/.test(shown) || setup.interrupted("Hold on").test(shown)
        const activity = t1.summary().activity
        const why = `attempt ${attempt}, lead ${ahead} ms, read ${read.join(", ")}:\n${shown}`
        expect(activity?.state, why).toBe("idle")
        if (shown.includes("Too late.") && !stopped) {
          tried.push(`${ahead} ms: ${ended ? "ended well before the key" : "the reply won"}`)
          if (!ended) lost += 1
          expect(activity?.lastTurn, why).toMatchObject({
            outcome: "completed",
            reply: "Too late.",
          })
        } else {
          tried.push(`${ahead} ms: the key won`)
          expect(activity?.lastTurn?.outcome, why).toBe("interrupted")
          // Where the Escape ended the turn first, a Stop after it is not the end until the
          // harness has said it didn't take the key. (A Stop told before the key ended the
          // turn completed, and the harness's interruption after it replaces that: clients
          // hold a finish for `finishGraceMs` for it.)
          if (read[0] === "interrupted") expect(read, why).not.toContain("completed")
        }
        await run.deck.terminals.close({ terminalId: t1.id }).catch(() => {})
      }
      expect(
        lost,
        `the reply won no race the key was in, in ${tried.length} attempts: ${tried.join("; ")}`,
      ).toBeGreaterThan(0)
    })
  })
}
