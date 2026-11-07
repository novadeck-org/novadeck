// PROBE, not a test of Novadeck (#757): each harness with two messages queued, a Stop landing
// as its turn ends by itself, and what its own key for taking them out does. Reply first by
// PROBE_LEAD ms (negative: after the Stop). Runs only with NOVADECK_E2E_PROBES=1, by path.
/* eslint-disable no-await-in-loop -- A probe's steps run in order. */
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { own, start } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const out = process.env.PROBE_OUT ?? join(process.env.HOME ?? ".", "probe-out")
mkdirSync(out, { recursive: true })
const leads = (process.env.PROBE_LEADS ?? "-100,0,100,300").split(",").map(Number)
const takeKeys = process.env.PROBE_TAKE

for (const setup of setups)
  describe.skipIf(!supported || !probing)(`probe: ${setup.name}, a Stop as its turn ends`, () => {
    const it = e2e(setup)
    for (const lead of takeKeys ? [0] : leads)
      it(`reply ${lead} ms before the Stop`, { timeout: 120_000 }, async ({ e2e: run }) => {
        const held = gate()
        const queuedHeld = gate()
        const calls: string[] = []
        run.model.use(
          own(async (call) => {
            if (asked(call, "Queued")) {
              const last = call.turns.findLast((turn) => turn.role === "user")
              calls.push(last && "text" in last ? last.text.replace(/\s+/g, " ").slice(0, 60) : "")
              await queuedHeld.opened
              return { text: "Queued late." }
            }
            if (!asked(call, "Hold on")) return undefined
            await held.opened
            return { text: "Too late." }
          }),
        )
        const t1 = await start(run, setup)
        const mark = t1.mark()
        await t1.prompt("Hold on")
        await t1.reached("working", { after: mark })
        await sleep(2500)
        await t1.prompt("Queued beta")
        await t1.prompt("Queued gamma")
        await sleep(1500)
        const tail = async () =>
          (await t1.screen())
            .split("\n")
            .filter((row) => row.trim())
            .slice(-9)
            .map((row) => row.slice(0, 80))
        const report = async (fields: object) =>
          appendFileSync(
            join(out, "turn-end.txt"),
            `${JSON.stringify({ harness: setup.agent, lead, ...fields, calls, screen: await tail() })}\n`,
          )
        if (takeKeys) {
          const before = await tail()
          t1.press(JSON.parse(`"${takeKeys}"`) as string)
          await sleep(1500)
          await report({ before })
          held.open()
          queuedHeld.open()
          return
        }
        let stopping: Promise<{ returned?: string | null | undefined }>
        if (lead >= 0) {
          held.open()
          await sleep(lead)
          stopping = t1.interrupt()
        } else {
          stopping = t1.interrupt()
          await sleep(-lead)
          held.open()
        }
        const stopped = await stopping
        await sleep(3000)
        const state = t1.summary().activity?.state
        await report({ returned: stopped.returned ?? null, state })
        // Whether the queued turn still ran: a reply let go now shows only if it was left running.
        queuedHeld.open()
        await sleep(2500)
        await report({
          after: "queued reply let go",
          shows: (await t1.screen()).includes("Queued late."),
        })
      })
  })
