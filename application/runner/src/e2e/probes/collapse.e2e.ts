// PROBE, not a test of Novadeck: where each harness's box starts to show a paste as a
// placeholder, in lines (short ones) and in characters (one line of words), so a prompt
// can be told to collapse (or not) before it is pasted. Runs only with NOVADECK_E2E_PROBES=1,
// by path; writes $PROBE_OUT/<agent>-collapse-<pin|latest>.json: for each shape, whether the
// box showed the text (`shown`) or something else, and its rows.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import headless from "@xterm/headless"

import { box as agyBox } from "../../harnesses/agy/box.js"
import { compact } from "../../harnesses/box.js"
import { box as claudeBox } from "../../harnesses/claude/box.js"
import { box as codexBox } from "../../harnesses/codex/box.js"
import { screenText } from "../../terminals/screen.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { start } from "../scenarios.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const paste = (words: string) => `\x1b[200~${words.replace(/\n/g, "\r")}\x1b[201~`
const probing = process.env.NOVADECK_E2E_PROBES === "1"
const profiles = { claude: claudeBox, codex: codexBox, agy: agyBox }

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: collapse of ${setup.name}`, () => {
    const it = e2e(setup)
    it("pastes of growing size", async ({ e2e: run }) => {
      const t = await start(run, setup)
      const raw = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")
      const profile = profiles[setup.agent]
      const out: Record<string, unknown> = {}
      const look = async (): Promise<ReturnType<typeof profile.read>> => {
        const { terminals } = run.deck
        const controller = new AbortController()
        const stream = terminals.attach(
          { terminalId: t.id, mode: "observe" },
          "reader",
          controller.signal,
        )
        try {
          for await (const event of stream) {
            if (event.type !== "snapshot") continue
            const { cols, rows } = terminals.get(t.id)
            const screen = new headless.Terminal({
              cols,
              rows,
              scrollback: 0,
              allowProposedApi: true,
            })
            await new Promise<void>((resolve) => screen.write(event.data, resolve))
            const read = profile.read(screenText(screen))
            screen.dispose()
            return read
          }
        } finally {
          controller.abort()
          await stream.return(undefined)
        }
        return undefined
      }
      const clear = async () => {
        for (let step = 0; step < 10; step += 1) {
          raw("\x15\x7f".repeat(5))
          await sleep(100)
        }
        raw("\x15")
        await sleep(400)
      }
      const shapes: [string, string][] = []
      for (let n = 3; n <= 30; n += 1)
        shapes.push([
          `${n} short lines`,
          Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join("\n"),
        ])
      for (const n of [4, 6, 8, 10, 12, 15])
        // a hundred characters a line
        shapes.push([
          `${n} lines of 100 chars`,
          Array.from({ length: n }, (_, i) => `L${i + 1} `.padEnd(99, "x")).join("\n"),
        ])
      for (const n of [500, 800, 900, 950, 1000, 1024, 1100, 1300])
        shapes.push([`${n} chars one line`, Array.from({ length: n / 5 }, () => "abcd").join(" ")])
      for (const [name, words] of shapes) {
        raw(paste(words))
        await sleep(900)
        const read = await look()
        out[name] = {
          shown: read !== undefined && compact(read.text) === compact(words),
          collapsed: read !== undefined && profile.collapsed(read),
          rows: read ? read.last - read.first + 1 : null,
          text: read && compact(read.text) !== compact(words) ? read.text.slice(0, 60) : undefined,
        }
        await clear()
      }
      const dir = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, `${setup.agent}-collapse-${process.env.NOVADECK_E2E_HARNESS ?? "pin"}.json`),
        JSON.stringify(out, null, 1),
      )
    })
  })
}
