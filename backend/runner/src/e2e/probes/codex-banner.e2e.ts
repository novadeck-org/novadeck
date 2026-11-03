// PROBE, not a test of Novadeck: where Codex's banner ("OpenAI Codex (v0.166.0)") stands on
// its screen as a process starts, and whether the runner's binding takes the running version
// from it. A session of several turns is begun, the runner restarted and the terminal
// restored with `codex resume`, as Novadeck does after an upgrade. Runs only with
// NOVADECK_E2E_PROBES=1 and NOVADECK_E2E_AGENTS=codex, by path; writes $PROBE_OUT/banner.json:
// a timeline of the resumed screen (when the banner showed, on which row), the binding after
// the first prompt, and the screens that `harnesses/codex/src/fixtures/banner.probe.json`
// keeps. (Two releases can't be used: the older Codex starts an app-server daemon that keeps
// the session locked to the newer one.)
/* eslint-disable no-await-in-loop -- The turns and samples run in order. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { codex } from "../agents/codex.js"
import { describe, e2e, supported } from "../fixture.js"
import { installHarness } from "../install.js"
import { replies, start } from "../scenarios.js"

const out = process.env.PROBE_OUT
const turns = 7
const banner = /^\s*>_ OpenAI Codex \(v(\S+)\)/

type Inside = {
  records: Map<string, { bound: { binding: { version?: string; created?: true } } | null }>
}

describe.skipIf(!out || !supported)("probe: Codex's banner", () => {
  const it = e2e(codex)
  it("shows the running release at a start and at the resume of a long session", async ({
    e2e: run,
  }) => {
    const installed = await installHarness("codex")
    for (let turn = 1; turn <= turns + 1; turn++)
      run.model.use(replies(`Turn ${turn}`, `Done ${turn}.`))
    const screens: Record<string, unknown> = {}
    const inside = run.deck.terminals as unknown as Inside
    const first = await start(run, codex)
    screens.freshStart = screenRecord((await first.screenText())!)
    for (let turn = 1; turn <= turns; turn++) {
      await first.submit(`Turn ${turn}`)
      await first.until(`Done ${turn}.`, 60_000)
    }
    await first.reached("settled")
    screens.afterTurns = screenRecord((await first.screenText())!)
    const fresh = inside.records.get(first.id)?.bound?.binding

    await run.deck.restart()
    const began = Date.now()
    const second = await run.deck.restore(first, { resume: "codex" })
    // The restarted runner's terminals, not the first's.
    const after = run.deck.terminals as unknown as Inside
    const timeline: { ms: number; row: number | null; version: string | null }[] = []
    const bindings: { ms: number; version?: string; created?: true }[] = []
    let sampling = false
    const sample = async () => {
      if (sampling) return
      sampling = true
      try {
        const shown = await second.screenText()
        if (shown) {
          const row = shown.rows.findIndex((each) => banner.test(each))
          const place = row < 0 ? null : row
          if (timeline.length === 0 || timeline.at(-1)!.row !== place)
            timeline.push({
              ms: Date.now() - began,
              row: place,
              version: row < 0 ? null : (banner.exec(shown.rows[row]!)?.[1] ?? null),
            })
          if (row >= 0 && screens.resumeStart === undefined)
            screens.resumeStart = screenRecord(shown)
        }
        const binding = after.records.get(second.id)?.bound?.binding
        if (binding && bindings.length === 0)
          bindings.push({
            ms: Date.now() - began,
            ...(binding.version && { version: binding.version }),
            ...(binding.created && { created: binding.created }),
          })
      } finally {
        sampling = false
      }
    }
    const watching = setInterval(() => void sample(), 25)
    try {
      await second.reached("ready", { timeoutMs: 60_000 })
      screens.resumeAtPrompt = screenRecord((await second.screenText())!)
      await second.submit(`Turn ${turns + 1}`)
      await second.until(`Done ${turns + 1}.`, 60_000)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    } finally {
      clearInterval(watching)
    }
    const afterTurn = after.records.get(second.id)?.bound?.binding
    screens.resumeAfterTurn = screenRecord((await second.screenText())!)
    mkdirSync(out!, { recursive: true })
    writeFileSync(
      join(out!, "banner.json"),
      JSON.stringify(
        {
          running: installed.version,
          fresh,
          timeline,
          boundFirst: bindings[0],
          boundAfterTurn: afterTurn,
          screens,
        },
        null,
        2,
      ),
    )
  })
})
