// PROBE, not a test of Novadeck: how many rows of a text taller than its box each harness shows,
// on screens of many heights, with and without background agents listed under the box: whether
// a box full of text can be told by its height (`BoxProfile.viewport`), or shows less than that
// says. Runs only with NOVADECK_E2E_PROBES=1, by path. Writes $PROBE_OUT/<agent>-viewport.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { box as agyBox } from "@novadeck/harness-agy/box"
import { box as claudeBox } from "@novadeck/harness-claude/box"
import { box as codexBox } from "@novadeck/harness-codex/box"
import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { gate, type Call } from "../model/script.js"
import { answers, own, result, start } from "../scenarios.js"
import { paste, probing, sleep } from "./support.js"

const profiles = { claude: claudeBox, codex: codexBox, agy: agyBox }
const heights = [14, 15, 18, 23, 24, 25, 26, 31, 33, 40, 41, 47, 50, 51, 60, 61]
const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: viewport in ${setup.name}`, () => {
    const it = e2e(setup)
    const profile = profiles[setup.agent]

    for (const lane of ["idle", "background", "status line"] as const) {
      it(lane, async ({ e2e: run }) => {
        // A person's status line of several rows, under the box where a harness has one.
        if (lane === "status line") {
          const settings = join(run.sandbox.project, ".claude")
          mkdirSync(settings, { recursive: true })
          const command = "printf 'first\\nsecond\\nthird\\nfourth\\n'"
          writeFileSync(
            join(settings, "settings.local.json"),
            JSON.stringify({ statusLine: { type: "command", command } }),
          )
        }
        const held = gate()
        const { background } = setup
        const owns = (call: Call) => background?.owns(call) === true
        // Three, as a longer list under the box is what could take rows from it.
        const three = (call: Call) => {
          const reply = background!.start(call) as { readonly calls: readonly unknown[] }
          return { calls: [...reply.calls, ...reply.calls, ...reply.calls] } as never
        }
        run.model.use(
          own(async (call) => {
            if (!owns(call)) return undefined
            await held.opened
            return { text: "Done." }
          }),
          ...(lane === "background" ? [answers("Start the work", three)] : []),
          own((call) =>
            result(call) !== undefined && !owns(call) ? { text: "Started." } : undefined,
          ),
          () => ({ text: "Noted." }),
        )
        const t = await start(run, setup)
        const raw = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")
        if (lane === "background" && background) {
          await t.submit("Start the work")
          await t.until("Started.")
          await t.poll(
            () => ((t.summary().activity?.background?.agents ?? 0) > 0 ? true : undefined),
            "a background agent",
          )
          await sleep(1500)
        }
        for (let at = 0; at < 30; at += 1) {
          raw(paste(`Part ${at} of it\nits next line\nits last line`))
          await sleep(120)
        }
        const record: unknown[] = []
        for (const rows of heights) {
          t.resize(120, rows)
          await sleep(1800)
          const screen = await t.screenText()
          const read = screen && profile.read(screen)
          const shown = read ? read.last - read.first + 1 : null
          const listed = (screen?.rows ?? []).filter(
            (row) => row.includes("◯") || /agents?\b/.test(row),
          )
          record.push({
            rows,
            listed: listed.map((row) => row.trim().slice(0, 50)).slice(0, 5),
            shown,
            viewport: profile.viewport?.(rows) ?? null,
            scrolled: read?.scrolled ?? false,
            screen: screen ? screenRecord(screen) : null,
          })
        }
        held.open()
        mkdirSync(outDir, { recursive: true })
        const name = lane.replace(" ", "-")
        writeFileSync(join(outDir, `${setup.agent}-viewport-${name}.json`), JSON.stringify(record))
      })
    }
  })
}
