// PROBE, not a test of Novadeck: how Claude Code draws a box that shows only part of what it
// holds, for `ruledBox` and its profile's `cut`: a text taller than its box, its head scrolled
// away (a reply of ten rows on a 40×12 screen), and a draft under blank lines with the cursor
// moved back up over them, its words scrolled away below (80×12). From 2.1.326 a rule of the box
// says so (`─── ↑ 7 more ───`), where 2.1.325 drew plain rules and led the first row shown with
// `❯`. Runs only with NOVADECK_E2E_PROBES=1, by path, once per version (NOVADECK_E2E_HARNESS);
// writes $PROBE_OUT/claude-scrolled-box-<version>.json, its `states` for
// harnesses/claude/src/fixtures/scrolled-box.probe.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { box } from "@novadeck/harness-claude/box"
import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { replies, start, turn } from "../scenarios.js"
import { paste, probing, sleep } from "./support.js"

const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")
const setup = setups.find((each) => each.agent === "claude")!

describe.skipIf(!supported || !probing || !setup)("probe: Claude Code's scrolled box", () => {
  e2e(setup)("draws its rules and first row", async ({ e2e: run }) => {
    run.model.use(replies("Warm up", "Warmed up."), () => ({ text: "Noted." }))
    const t = await start(run, setup)
    await turn(t, "Warm up", "Warmed up.")
    const raw = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")
    const version = /Claude Code v(\d+\.\d+\.\d+)/.exec(await t.screen())?.[1] ?? "unknown"
    const states: Record<string, unknown> = {}
    const take = async (name: string) => {
      await t.settled()
      const screen = (await t.screenText())!
      const read = box.read(screen)
      states[name] = screenRecord(screen)
      states[`${name}Read`] = read ?? null
    }

    // Its head scrolled away above.
    t.resize(40, 12)
    await sleep(1_200)
    raw(paste(`Merge it${" and say so in the changelog".repeat(7)}, thanks.`))
    await t.until("thanks.")
    await take("above")
    raw("\x15".repeat(12))
    await sleep(500)

    // Its words scrolled away below: blank lines, words, and the cursor back up over the blanks.
    t.resize(80, 12)
    await sleep(1_200)
    for (let line = 0; line < 3; line += 1) {
      raw("\n")
      await sleep(150)
    }
    raw("MY DRAFT BELOW")
    await t.until("MY DRAFT BELOW")
    for (let line = 0; line < 3; line += 1) {
      raw("\x1b[A")
      await sleep(200)
    }
    await take("below")

    mkdirSync(outDir, { recursive: true })
    writeFileSync(
      join(outDir, `claude-scrolled-box-${version}.json`),
      JSON.stringify({ version, states }, null, 2),
    )
  })
})
