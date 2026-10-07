// PROBE, not a test of Novadeck: whether a long or multi-line prompt that Escape interrupts
// comes back into the harness's box as its text or as a "[Pasted text #N …]" placeholder,
// which decides whether `interrupt` may take a placeholder for the turn's own prompt
// (`collapsible(prompt) && profile.collapsed(box)`). For each shape a turn is held mid-flight
// with that prompt, a raw Escape is pressed (not `interrupt`, which would clean the box), and
// the box as the adapter reads it is recorded before and after. Runs only with
// NOVADECK_E2E_PROBES=1, by path; writes $PROBE_OUT/<agent>-interrupted-paste-<pin|latest>.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import headless from "@xterm/headless"

import { box as agyBox } from "../../harnesses/agy/box.js"
import { box as claudeBox } from "../../harnesses/claude/box.js"
import { box as codexBox } from "../../harnesses/codex/box.js"
import { collapsible } from "../../terminals/prompts.js"
import { screenText } from "../../terminals/screen.js"
import { screenRecord } from "../../testing/probes.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { start } from "../scenarios.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const probing = process.env.NOVADECK_E2E_PROBES === "1"
const profiles = { claude: claudeBox, codex: codexBox, agy: agyBox }

const lines = (n: number) =>
  ["Hold on", ...Array.from({ length: n - 1 }, (_, i) => `line ${i + 2} of the prompt`)].join("\n")
const long = (n: number) => `Hold on ${"words ".repeat(Math.ceil(n / 6))}`.slice(0, n)
const shapes: readonly { name: string; text: string; rows?: number }[] = [
  // The same tall prompt on screens of other heights: what caps the box's viewport.
  { name: "40 lines on 24 rows", text: lines(40), rows: 24 },
  { name: "40 lines on 60 rows", text: lines(40), rows: 60 },
  { name: "2000 chars on 24 rows", text: long(2000), rows: 24 },
  { name: "3 lines", text: lines(3) },
  { name: "6 lines", text: lines(6) },
  { name: "20 lines", text: lines(20) },
  { name: "40 lines", text: lines(40) },
  { name: "one line of 300 chars", text: long(300) },
  { name: "one line of 1200 chars", text: long(1200) },
  { name: "one line of 2000 chars", text: long(2000) },
]

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: interrupted paste in ${setup.name}`, () => {
    const it = e2e(setup)
    it("each shape", async ({ e2e: run }) => {
      let held = gate()
      run.model.use(
        async (call) => {
          if (call.side || !asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Held." }
        },
        (call) => (!call.side ? { text: "Fine." } : undefined),
      )
      const profile = profiles[setup.agent]
      const out: Record<string, unknown> = {}
      for (const shape of shapes) {
        held = gate()
        const t = await start(run, setup)
        if (shape.rows) {
          run.deck.terminals.resize({ terminalId: t.id, cols: 120, rows: shape.rows }, "e2e")
          await sleep(500)
        }
        const look = async (label: string) => {
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
              const read = screenText(screen)
              const box = profile.read(read)
              screen.dispose()
              return {
                label,
                state: terminals.get(t.id).activity?.state,
                box: box ? { text: box.text, first: box.first, last: box.last } : null,
                collapsed: box ? profile.collapsed(box) : null,
                ...screenRecord(read),
              }
            }
          } finally {
            controller.abort()
            await stream.return(undefined)
          }
          return undefined
        }
        const states: unknown[] = []
        try {
          await t.prompt(shape.text)
        } catch (error) {
          // A shape the harness's box has no room for is not given.
          out[shape.name] = { refused: String(error) }
          continue
        }
        await run.model.waitFor((call) => !call.side && asked(call, "Hold on"))
        await t.reached("working", { after: 0 })
        await sleep(1000)
        states.push(await look("working"))
        run.deck.terminals.write({ terminalId: t.id, data: "\x1b" }, "e2e")
        await sleep(300)
        states.push(await look("esc +0.3s"))
        await sleep(1500)
        states.push(await look("esc +1.8s"))
        out[shape.name] = { collapsible: collapsible(shape.text), states }
        held.open()
        await sleep(500)
        const dir = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          join(
            dir,
            `${setup.agent}-interrupted-paste-${process.env.NOVADECK_E2E_HARNESS ?? "pin"}.json`,
          ),
          JSON.stringify(out, null, 1),
        )
      }
    })
  })
}
