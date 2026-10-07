// PROBE, not a test of Novadeck: what Escape does while a message the person queued
// mid-turn waits (Claude Code and Antigravity queue it; Codex steers with it), and how the
// box can be cleared afterwards. For each variant a turn is held mid-flight, one or two
// prompts are given, keys are written, and after each step the screen's sparse state, the
// box as the adapter reads it and the agent's activity are recorded. Runs only with
// NOVADECK_E2E_PROBES=1, by path; writes $PROBE_OUT/<agent>-queued-<pin|latest>.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import headless from "@xterm/headless"

import { box as agyBox } from "../../harnesses/agy/box.js"
import { box as claudeBox } from "../../harnesses/claude/box.js"
import { box as codexBox } from "../../harnesses/codex/box.js"
import { screenText } from "../../terminals/screen.js"
import { screenRecord } from "../../testing/probes.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { start } from "../scenarios.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const probing = process.env.NOVADECK_E2E_PROBES === "1"
const profiles = { claude: claudeBox, codex: codexBox, agy: agyBox }
const ESC = "\x1b"

type Step = readonly [label: string, keys: string]
const real: Step = ["interrupt()", "INTERRUPT"]
const variants: readonly {
  name: string
  queued: string[]
  steps: Step[]
  pause?: number
}[] = [
  ...[0, 100, 300, 600].flatMap((pause) =>
    [1, 2, 3].map((n) => ({
      name: `real interrupt after ${pause} ms, run ${n}`,
      queued: ["Queued beta"],
      steps: [real] as Step[],
      pause,
    })),
  ),
  ...[1, 2, 3, 4].map((n) => ({
    name: `real interrupt ${n}`,
    queued: ["Queued beta"],
    steps: [real] as Step[],
  })),
  { name: "real interrupt, two queued", queued: ["Queued beta", "Queued gamma"], steps: [real] },
  { name: "one queued, Esc", queued: ["Queued beta"], steps: [["esc", ESC]] },
  {
    name: "one queued, Esc, Esc",
    queued: ["Queued beta"],
    steps: [
      ["esc", ESC],
      ["esc again", ESC],
    ],
  },
  {
    name: "one queued, Esc, Ctrl-U clear, Esc",
    queued: ["Queued beta"],
    steps: [
      ["esc", ESC],
      ["ctrl-u x3", "\x15\x15\x15"],
      ["esc after clear", ESC],
    ],
  },
  {
    name: "one queued, Esc, backspaces, Esc",
    queued: ["Queued beta"],
    steps: [
      ["esc", ESC],
      ["backspace x20", "\x7f".repeat(20)],
      ["esc after clear", ESC],
    ],
  },
  {
    name: "two queued, Esc",
    queued: ["Queued beta", "Queued gamma"],
    steps: [["esc", ESC]],
  },
  {
    name: "two queued, Esc, Esc, Esc",
    queued: ["Queued beta", "Queued gamma"],
    steps: [
      ["esc", ESC],
      ["esc 2", ESC],
      ["esc 3", ESC],
    ],
  },
  {
    name: "one queued, double Esc at once",
    queued: ["Queued beta"],
    steps: [["esc esc", `${ESC}${ESC}`]],
  },
]

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: queued message and Stop in ${setup.name}`, () => {
    const it = e2e(setup)
    it("each variant", async ({ e2e: run }) => {
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
      for (const variant of variants) {
        held = gate()
        const t = await start(run, setup)
        const raw = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")
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
        await t.prompt("Hold on")
        await run.model.waitFor((call) => !call.side && asked(call, "Hold on"))
        await t.reached("working", { after: 0 })
        for (const text of variant.queued) {
          try {
            await t.prompt(text)
          } catch (error) {
            states.push({ label: `prompt ${text} failed`, error: String(error) })
            states.push(await look("after the failed prompt"))
          }
        }
        await sleep(variant.pause ?? 1500)
        states.push(await look("queued"))
        for (const [label, keys] of variant.steps) {
          if (keys === "INTERRUPT") await t.interrupt()
          else raw(keys)
          await sleep(300)
          states.push(await look(`${label} +0.3s`))
          await sleep(1500)
          states.push(await look(label))
          await sleep(2000)
          states.push(await look(`${label} +3.8s`))
        }
        out[variant.name] = states
        const dir0 = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
        mkdirSync(dir0, { recursive: true })
        writeFileSync(
          join(dir0, `${setup.agent}-queued-${process.env.NOVADECK_E2E_HARNESS ?? "pin"}.json`),
          JSON.stringify(out, null, 1),
        )
        // Whatever is left: the next variant has a terminal of its own.
        held.open()
        await sleep(500)
      }
      const dir = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, `${setup.agent}-queued-${process.env.NOVADECK_E2E_HARNESS ?? "pin"}.json`),
        JSON.stringify(out, null, 1),
      )
    })
  })
}
