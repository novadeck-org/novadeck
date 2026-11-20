// Probe (the doorbell tag): how each harness's box takes and reads the tag, pasted (as the
// doorbell does) and typed a key at a time (what a picker or autocomplete would show), at
// several sizes. Runs only with NOVADECK_E2E_PROBES=1, by path; writes $PROBE_OUT/tag-box-<agent>.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { ScreenText } from "@novadeck/emulator/headless"
import { doorbellLine, replyLine } from "@novadeck/harness-core/prompts"
import { screenRecord } from "@novadeck/harness-core/testing/probes"
import { isEmpty } from "@novadeck/tui-input/box"

import { harnesses } from "../../harnesses/registry.js"
import { closingNonce, leftoverNonce, holdsRingLine } from "../../terminals/leftover.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { replies, start, turn } from "../scenarios.js"
import { paste, probing, sleep } from "./support.js"

const sizes = [
  [40, 14],
  [80, 24],
  [120, 24],
  [200, 24],
] as const
const lines = {
  "tag, one handle": doorbellLine("kVxbQo", ["moth"]),
  "tag, two handles": doorbellLine("kVxbQo", ["newtz", "hushz"]),
  "tag, notice": doorbellLine("kVxbQo", ["novadeck"]),
  "tag, no handles": doorbellLine("kVxbQo"),
  "tag, five handles": doorbellLine("kVxbQo", ["newtz", "hushz", "moth", "fox", "novadeck"]),
  "reply tag": replyLine([
    { subject: "Merge the branch?", option: "Merge", text: "yes & tidy <b>up</b> [soon] @x $y" },
  ])!("n7Q2kx"),
}
const erase = `${"\x15\x7f".repeat(24)}\x15`
const only = process.env.PROBE_ONLY ? new RegExp(process.env.PROBE_ONLY) : undefined
const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: tag in the box, ${setup.name}`, () => {
    const it = e2e(setup)
    const profile = harnesses[setup.agent].box!
    for (const [columns, rows] of sizes.filter(() => true))
      it(`${columns}x${rows}`, { timeout: 300_000 }, async ({ e2e: run }) => {
        if (only && !only.test(`${columns}x${rows}`)) return
        run.model.use(replies("Warm up", "Warmed up."), () => ({ text: "Noted." }))
        const t = await start(run, setup)
        await turn(t, "Warm up", "Warmed up.")
        t.resize(columns, rows)
        await sleep(1500)
        const record: unknown[] = []
        const look = async (label: string, how: string, line: string) => {
          await t.settled().catch(() => undefined)
          const screen: ScreenText | undefined = await t.screenText()
          const read = screen && profile.read(screen)
          record.push({
            label,
            how,
            line,
            box: read ?? null,
            empty: read ? isEmpty(read) : null,
            overlay: screen ? profile.overlay(screen) : null,
            leftoverNonce: read ? (leftoverNonce(read.text) ?? null) : null,
            closingNonce: read ? (closingNonce(read.text) ?? null) : null,
            holdsRingLine: read ? holdsRingLine(read.text) : null,
            screen: screen ? screenRecord(screen) : null,
          })
        }
        for (const [label, line] of Object.entries(lines)) {
          run.deck.terminals.write({ terminalId: t.id, data: paste(line) }, "e2e")
          await sleep(1200)
          await look(label, "pasted", line)
          run.deck.terminals.write({ terminalId: t.id, data: erase }, "e2e")
          await sleep(1200)
          await look(label, "erased", "")
          // Typed a key at a time: what a picker, autocomplete or `/`-command would do.
          for (const char of line) {
            run.deck.terminals.write({ terminalId: t.id, data: char }, "e2e")
            await sleep(15)
          }
          await sleep(1200)
          await look(label, "typed", line)
          run.deck.terminals.write({ terminalId: t.id, data: erase }, "e2e")
          await sleep(1200)
        }
        mkdirSync(outDir, { recursive: true })
        const path = join(outDir, `tag-box-${setup.agent}.json`)
        const out = existsSync(path)
          ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
          : {}
        out[`${columns}x${rows}`] = record
        writeFileSync(path, JSON.stringify(out, null, 2))
      })
  })
}
