// PROBE, not a test of Novadeck (#757): whether Claude Code's screen tells a turn it runs from
// its queue, which fires no prompt hook, from a turn winding down after its Stop. Each round
// lets a held reply go and reads the screen every PROBE_EVERY ms (25) for PROBE_FOR ms (6000),
// beside the deliveries Novadeck recorded: `queued`, a prompt queued behind the turn; `plain`,
// none. Runs only with NOVADECK_E2E_PROBES=1, by path; writes $PROBE_OUT/queued-busy.jsonl.
/* eslint-disable no-await-in-loop -- A probe's steps run in order. */
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import { claude } from "../agents/claude.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { own, start } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const out = process.env.PROBE_OUT ?? join(process.env.HOME ?? ".", "probe-out")
mkdirSync(out, { recursive: true })
const every = Number(process.env.PROBE_EVERY ?? 25)
const lasting = Number(process.env.PROBE_FOR ?? 6000)
const rounds = Number(process.env.PROBE_ROUNDS ?? 3)

describe.skipIf(!supported || !probing)("probe: Claude Code, a queued turn's screen", () => {
  const it = e2e(claude)
  for (const shape of ["queued", "plain"] as const)
    for (let round = 0; round < rounds; round += 1)
      it(`${shape}, round ${round + 1}`, { timeout: 120_000 }, async ({ e2e: run }) => {
        const held = gate()
        const queuedHeld = gate()
        const calls: { what: string; at: number }[] = []
        run.model.use(
          own(async (call) => {
            if (asked(call, "Queued beta")) {
              calls.push({ what: "queued", at: Date.now() })
              await queuedHeld.opened
              return { text: "Queued done." }
            }
            if (!asked(call, "Hold on")) return undefined
            calls.push({ what: "held", at: Date.now() })
            await held.opened
            return { text: "Held reply." }
          }),
        )
        const t1 = await start(run, claude)
        const mark = t1.mark()
        await t1.prompt("Hold on")
        await t1.reached("working", { after: mark })
        await sleep(1500)
        if (shape === "queued") {
          await t1.prompt("Queued beta")
          await sleep(1500)
        }
        const from = t1.mark()
        const t0 = Date.now()
        held.open()
        const frames: { t: number; rows: readonly string[] }[] = []
        let last = ""
        while (Date.now() - t0 < lasting) {
          const shown = await t1.screenText()
          const rows = (shown?.rows ?? []).map((row) => row.trimEnd())
          const key = rows.join("\n")
          // Only what changed, with when it did.
          if (key !== last) frames.push({ t: Date.now() - t0, rows })
          last = key
          // The queued turn's reply goes once its spinner has had time to show.
          if (shape === "queued" && Date.now() - t0 > lasting / 2) queuedHeld.open()
          await sleep(every)
        }
        queuedHeld.open()
        const deliveries = t1
          .history()
          .slice(from)
          .map((each) => ({ t: each.at - t0, delivery: each.delivery }))
        appendFileSync(
          join(out, "queued-busy.jsonl"),
          `${JSON.stringify({
            shape,
            round,
            calls: calls.map(({ what, at }) => ({ what, t: at - t0 })),
            deliveries,
            frames,
          })}\n`,
        )
      })
})
