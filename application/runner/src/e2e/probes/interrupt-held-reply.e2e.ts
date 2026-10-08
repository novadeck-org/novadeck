// PROBE, not a test of Novadeck: whether Escape stops a turn whose model call is held, and
// whether the held reply ("Too late.") ever reaches the screen after the gate opens, by
// the prompt's shape (1 to 40 lines, long single lines), by when Escape lands after the
// model call arrived, and by how it is sent (the runner's `interrupt`, or a raw Escape).
// Each case is run several times; each run records the activity's states after Escape, and
// whether the reply was drawn once the gate opened, and which facts reached the activity
// (hooks, records, status lines, the runner's own Escape) and when, relative to the key.
// PROBE_SHAPE and PROBE_CASE keep only the shapes and cases whose names contain them. Runs only with NOVADECK_E2E_PROBES=1, by
// path; writes $PROBE_OUT/<agent>-interrupt-held-reply-<pin|latest>.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "../../testing/probes.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { start } from "../scenarios.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const probing = process.env.NOVADECK_E2E_PROBES === "1"
const runs = Number(process.env.PROBE_RUNS ?? 3)
const onlyShape = process.env.PROBE_SHAPE
const onlyCase = process.env.PROBE_CASE

type Facts = { applyFact: (record: unknown, fact: Record<string, unknown>) => boolean }

const lines = (n: number) =>
  ["Hold on", ...Array.from({ length: n - 1 }, (_, i) => `line ${i + 2} of the prompt`)].join("\n")
const long = (n: number) => `Hold on ${"words ".repeat(Math.ceil(n / 6))}`.slice(0, n)
const shapes: readonly { name: string; text: string }[] = [
  { name: "1 line", text: lines(1) },
  { name: "3 lines", text: lines(3) },
  { name: "10 lines", text: lines(10) },
  { name: "25 lines", text: lines(25) },
  { name: "40 lines", text: lines(40) },
  { name: "one line of 300 chars", text: long(300) },
  { name: "one line of 2000 chars", text: long(2000) },
]
// Escape lands `pause` ms after the model call arrived, by `interrupt` or as a raw key, and
// the gate opens `wait` ms after that (a negative `wait` opens it that long before the
// Escape): a reply let go within the harness's Escape latency races the Escape.
const cases = [
  { how: "interrupt", pause: 0, wait: 0 },
  { how: "interrupt", pause: 0, wait: 1500 },
  { how: "interrupt", pause: 1500, wait: 0 },
  { how: "interrupt", pause: 1500, wait: 1500 },
  { how: "raw", pause: 1500, wait: 0 },
  { how: "raw", pause: 1500, wait: 100 },
  { how: "raw", pause: 1500, wait: 200 },
  { how: "raw", pause: 1500, wait: 300 },
  { how: "raw", pause: 1500, wait: 600 },
  { how: "raw", pause: 1500, wait: 1500 },
  { how: "raw", pause: 1500, wait: -10 },
  { how: "raw", pause: 1500, wait: -20 },
  { how: "raw", pause: 1500, wait: -30 },
  { how: "raw", pause: 1500, wait: -35 },
  { how: "raw", pause: 1500, wait: -40 },
  { how: "raw", pause: 1500, wait: -45 },
  { how: "raw", pause: 1500, wait: -50 },
  { how: "raw", pause: 1500, wait: -100 },
  { how: "raw", pause: 1500, wait: -200 },
  { how: "interrupt", pause: 1500, wait: -50 },
] as const

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: held reply after Stop in ${setup.name}`, () => {
    const it = e2e(setup)
    it("each case", { timeout: 3_600_000 }, async ({ e2e: run }) => {
      let held = gate()
      run.model.use(
        async (call) => {
          if (call.side || !asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Too late." }
        },
        (call) => (!call.side ? { text: "Fine." } : undefined),
      )
      const out: Record<string, unknown[]> = {}
      const dir = process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out")
      mkdirSync(dir, { recursive: true })
      // Every fact the activity is told of, with when, so a run shows which signals followed
      // its Escape. The manager's one entry for them is wrapped for the probe only.
      const told: { at: number; fact: Record<string, unknown>; applied: boolean }[] = []
      const manager = run.deck.terminals as unknown as Facts
      const applyFact = manager.applyFact.bind(manager)
      manager.applyFact = (record, fact) => {
        const applied = applyFact(record, fact)
        told.push({ at: Date.now(), fact: { ...fact, input: undefined }, applied })
        return applied
      }
      for (const shape of shapes) {
        if (onlyShape && !shape.name.includes(onlyShape)) continue
        for (const { how, pause, wait } of cases) {
          const key = `${shape.name}, ${how} ${pause} ms after the call, gate opens ${
            wait < 0 ? `${-wait} ms before` : `${wait} ms later`
          }`
          if (onlyCase && !key.includes(onlyCase)) continue
          out[key] = []
          for (let n = 1; n <= runs; n += 1) {
            held = gate()
            const t = await start(run, setup)
            const calls = run.model.mark()
            const mark = t.mark()
            const record: Record<string, unknown> = { run: n }
            told.length = 0
            // Each outcome a client read of the last turn, with when, in order.
            const read: { at: number; outcome: string | undefined }[] = []
            const watching = setInterval(() => {
              const outcome = t.summary().activity?.lastTurn?.outcome
              if (read.at(-1)?.outcome !== outcome) read.push({ at: Date.now(), outcome })
            }, 5)
            try {
              await t.prompt(shape.text)
              await run.model.waitFor((call) => !call.side && asked(call, "Hold on"), {
                after: calls,
              })
              await t.reached("working", { after: mark })
              await sleep(pause)
              if (wait < 0) {
                held.open()
                await sleep(-wait)
              }
              const sent = Date.now()
              if (how === "interrupt") {
                const stopped = await t.interrupt()
                record.returned = stopped.returned
              } else run.deck.terminals.write({ terminalId: t.id, data: "\x1b" }, "e2e")
              record.stateAfterEscape = t.summary().activity?.state
              record.lastTurnAfterEscape = t.summary().activity?.lastTurn
              await sleep(Math.max(0, wait))
              record.stateBeforeOpen = t.summary().activity?.state
              held.open()
              await sleep(3000)
              const shown = await t.screen()
              record.replyDrawn = shown.includes("Too late.")
              record.stateAfter = t.summary().activity?.state
              record.lastTurnAfter = t.summary().activity?.lastTurn
              record.outcomesRead = read.map(({ at, outcome }) => ({
                msAfterEscape: at - sent,
                outcome,
              }))
              record.facts = told
                .filter(({ fact }) => fact.type !== "telemetry-observed")
                .map(({ at, fact, applied }) => ({
                  msAfterEscape: at - sent,
                  type: fact.type,
                  outcome: fact.outcome,
                  recorded: fact.recorded,
                  reply: fact.reply,
                  startedAfterEscape: Number(fact.startedAt) - sent,
                  applied,
                }))
              record.modelCallsAfter = run.model.calls.slice(calls).filter((c) => !c.side).length
              record.msSinceEscape = Date.now() - sent
              record.screenAfter = screenRecord(shown)
            } catch (error) {
              record.error = String(error)
            }
            clearInterval(watching)
            held.open()
            // Each run's terminal goes, so later cases don't run under the load of earlier ones.
            await run.deck.terminals.close({ terminalId: t.id }, "e2e").catch(() => {})
            out[key].push(record)
            writeFileSync(
              join(
                dir,
                `${setup.agent}-interrupt-held-reply-${process.env.NOVADECK_E2E_HARNESS ?? "pin"}.json`,
              ),
              JSON.stringify(out, null, 1),
            )
          }
        }
      }
    })
  })
}
