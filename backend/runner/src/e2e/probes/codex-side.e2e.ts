// PROBE, not a test of Novadeck: what Codex draws for a `/side` conversation, at a width that
// leaves room for a pane beside the root's and one that doesn't, and what its box reads as at
// each step: opened, asked, answered, switched away and back, closed. Runs only with
// NOVADECK_E2E_PROBES=1, by path. Writes $PROBE_OUT/codex-side-<version>.json, each step a
// `ScreenRecord` with the box as the adapter reads it.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { ScreenText } from "@novadeck/emulator/headless"
import { screenRecord } from "@novadeck/harness-core/testing/probes"
import { isEmpty } from "@novadeck/tui-input/box"

import { harnesses } from "../../harnesses/registry.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { replies, start, turn } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const enter = "\r"
const ctrlC = "\x03"
const ctrlSlash = "\x1f"

type Step =
  | { readonly label: string; readonly keys: string; readonly wait?: number }
  | { readonly label: string; readonly resize: readonly [number, number] }

const steps: readonly Step[] = [
  { label: "side typed", keys: "/side" },
  { label: "side", keys: enter, wait: 3000 },
  { label: "side draft", keys: "Ask on the side" },
  { label: "side asked", keys: enter, wait: 4000 },
  { label: "switched", keys: ctrlSlash, wait: 1500 },
  { label: "switched back", keys: ctrlSlash, wait: 1500 },
  { label: "closed", keys: ctrlC, wait: 2000 },
  { label: "narrow", resize: [99, 40] },
  { label: "narrow side typed", keys: "/side" },
  { label: "narrow side", keys: enter, wait: 3000 },
  { label: "narrow side draft", keys: "Ask on the side" },
  { label: "wide again", resize: [120, 40] },
  { label: "wide closed", keys: ctrlC, wait: 2000 },
]

/** The keys in plain form: a line of `\xNN`s reads better in the record than raw controls. */
const shown = (keys: string): string =>
  // eslint-disable-next-line no-control-regex -- Control characters are what it shows.
  keys.replace(/[\x00-\x1f\x7f]/g, (key) => `\\x${key.charCodeAt(0).toString(16).padStart(2, "0")}`)

const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")

for (const setup of setups.filter((one) => one.agent === "codex")) {
  describe.skipIf(!supported || !probing)(`probe: /side in ${setup.name}`, () => {
    const it = e2e(setup)
    const profile = harnesses[setup.agent].box!

    it("draws a side conversation", { timeout: 600_000 }, async ({ e2e: run }) => {
      run.model.use(
        replies("Warm up", "Warmed up."),
        replies("Ask on the side", "Answered on the side."),
        () => ({ text: "Noted." }),
      )
      const t = await start(run, setup)
      await turn(t, "Warm up", "Warmed up.")
      const record: unknown[] = []
      const look = async (label: string, keys?: string) => {
        await t.settled().catch(() => undefined)
        const screen: ScreenText | undefined = await t.screenText()
        const read = screen && profile.read(screen)
        record.push({
          label,
          ...(keys !== undefined && { keys: shown(keys) }),
          box: read ?? null,
          empty: read ? isEmpty(read) : null,
          overlay: screen ? profile.overlay(screen) : null,
          delivery: t.history().at(-1)?.delivery ?? null,
          screen: screen ? screenRecord(screen) : null,
        })
      }
      await look("root")
      for (const step of steps) {
        if ("resize" in step) {
          t.resize(...step.resize)
          await sleep(1500)
          await look(step.label)
          continue
        }
        run.deck.terminals.write({ terminalId: t.id, data: step.keys }, "e2e")
        await sleep(step.wait ?? 1000)
        await look(step.label, step.keys)
      }
      mkdirSync(outDir, { recursive: true })
      const version = process.env.NOVADECK_E2E_HARNESS === "latest" ? "latest" : "pinned"
      writeFileSync(join(outDir, `codex-side-${version}.json`), JSON.stringify(record, null, 2))
    })
  })
}
