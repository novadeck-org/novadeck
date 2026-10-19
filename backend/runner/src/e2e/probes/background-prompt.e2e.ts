// PROBE, not a test of Novadeck: whether each harness takes a typed prompt at its box while
// only work its stopped turn left running runs (a subagent held mid-call), and what its
// screen shows then: right after the Stop, with a key typed, and once the prompt went in.
// Claude Code and Antigravity start a background subagent (their setups' `background`),
// Claude Code a background shell beside it;
// Codex spawns one (`spawn_agent`), which runs on with the root idle.
// Runs only with NOVADECK_E2E_PROBES=1, by path; writes what it saw to
// $PROBE_OUT/background-prompt-<agent>.json: each screen a `ScreenRecord` (harness-core's
// testing/probes.ts), and whether the root's model was called for the typed prompt while
// the subagent's call was still held (`took`).
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate, type Call, type Reply } from "../model/script.js"
import { own, result, start } from "../scenarios.js"

const probing = process.env.NOVADECK_E2E_PROBES === "1"
// The helper's own task, which only its conversation holds as a user's words.
const helper = "Helper task: wait for the build"

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(
    `probe: a prompt while ${setup.name}'s background work runs`,
    () => {
      const it = e2e(setup)
      it("records the screen, and whether a typed prompt starts a turn", async ({ e2e: run }) => {
        const finishing = gate()
        const spawning = setup.agent === "codex"
        // What starts the work, and whether a call is the work's own.
        const begin = (call: Call): Reply | undefined => {
          // Claude Code runs a shell in the background beside its agent, as the issue's did.
          if (setup.agent === "claude")
            return {
              calls: [
                ...(setup.background!.start(call).calls ?? []),
                ...(setup.background!.command!(call, "sleep 600").calls ?? []),
              ],
            }
          if (!spawning) return setup.background!.start(call)
          const spawn = call.tools.find((offered) => offered.endsWith("spawn_agent"))
          return spawn ? { calls: [{ name: spawn, input: { message: helper } }] } : undefined
        }
        const owns = (call: Call): boolean =>
          spawning
            ? !call.side &&
              call.turns.some((one) => one.role === "user" && one.text.includes(helper))
            : setup.background!.owns(call)
        run.model.use(
          own(async (call) => {
            if (!owns(call)) return undefined
            await finishing.opened
            return { text: "Background work done." }
          }),
          own((call) => (asked(call, "Start the work") ? begin(call) : undefined)),
          own((call) => (asked(call, "Ping now") ? { text: "Pong." } : undefined)),
          own((call) =>
            result(call) !== undefined && !owns(call) ? { text: "Started the work." } : undefined,
          ),
        )
        const t = await start(run, setup)
        const out: Record<string, unknown> = { harness: setup.agent }
        const look = async (label: string) => {
          const shown = await t.screenText()
          if (shown) out[label] = screenRecord(shown)
        }
        try {
          const calls = run.model.mark()
          await t.submit("Start the work")
          await run.model.waitFor(owns, { after: calls })
          await t.until("Started the work.")
          // The root's turn has ended, the work still held.
          await t.poll(() => {
            const activity = t.summary().activity
            return (spawning ? activity?.state === "idle" : activity?.background?.agents === 1)
              ? true
              : undefined
          }, "the root's turn to end, its work running")
          await sleep(3000)
          out.activity = t.summary().activity
          await look("1 stopped, work running")
          t.press("P")
          await sleep(1000)
          await look("2 a key typed")
          t.press("\x7f")
          await sleep(1000)
          const typed = run.model.mark()
          await t.submit("Ping now")
          const took = await run.model
            .waitFor((call) => !call.side && !owns(call) && asked(call, "Ping now"), {
              after: typed,
              timeoutMs: 30_000,
            })
            .then(
              () => true,
              () => false,
            )
          out.took = took
          await sleep(2000)
          await look("3 after the prompt")
        } finally {
          finishing.open()
          const dir = process.env.PROBE_OUT ?? "probe-out"
          mkdirSync(dir, { recursive: true })
          writeFileSync(
            join(dir, `background-prompt-${setup.agent}.json`),
            JSON.stringify(out, null, 2),
          )
        }
      })
    },
  )
}
