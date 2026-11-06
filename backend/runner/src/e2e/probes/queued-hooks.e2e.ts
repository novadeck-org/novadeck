// PROBE, not a test of Novadeck: when each harness runs its prompt hook for a message queued
// mid-turn, what its screen says meanwhile, and what comes of a Stop at a given moment after
// the queueing. Each harness gets a prompt hook 1.3 s slow that logs when it starts and ends.
// Two messages are queued behind a held turn, or with PROBE_WHEN=own-hook while the turn's own
// prompt hook still runs; the Stop comes `pause` ms after the second `prompt` resolved. A timeline of the screen's telling rows, the hook's log and the model's
// calls are kept. Runs only with NOVADECK_E2E_PROBES=1, by path; writes
// $PROBE_OUT/<agent>-queued-hooks.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { claude } from "../agents/claude.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate, latest } from "../model/script.js"
import { start } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const out = process.env.PROBE_OUT ?? join(process.env.HOME ?? ".", "probe-out")
const hookLog = join(out, "hook.log")
const script = join(out, "hook.cjs")
mkdirSync(out, { recursive: true })
writeFileSync(
  script,
  `const fs = require("fs")
let input = ""
try { input = fs.readFileSync(0, "utf8") } catch {}
const log = (phase) => fs.appendFileSync(${JSON.stringify(hookLog)}, JSON.stringify({ t: Date.now(), phase, input: input.slice(0, 400) }) + "\\n")
log("start")
setTimeout(() => { log("end"); console.log("{}") }, 1300)
`,
)

const telling =
  /UserPromptSubmit|send now|queued|Queued|Press up|submitted after|Interrupted|interrupted|esc to|hook/i

const ownHook = process.env.PROBE_WHEN === "own-hook"
const pauses = (process.env.PROBE_PAUSES ?? "0,500,1500,3000,6000").split(",").map(Number)

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: ${setup.name} queued hooks`, () => {
    const it = e2e.seeded({ promptHook: `node ${script}` }, setup)
    it("each pause", { timeout: 900_000 }, async ({ e2e: run }) => {
      const results: Record<string, unknown> = {}
      for (const pause of pauses) {
        writeFileSync(hookLog, "")
        const held = gate()
        const queuedHeld = gate()
        const calls: { t: number; latest: string }[] = []
        run.model.use(async (call) => {
          if (call.side) return undefined
          calls.push({ t: Date.now(), latest: latest(call).slice(0, 200) })
          if (asked(call, "Queued")) {
            await queuedHeld.opened
            return { text: "Queued late." }
          }
          if (asked(call, "Hold on")) {
            await held.opened
            return { text: "Too late." }
          }
          return { text: "Fine." }
        })
        const t = await start(run, setup)
        const marked = run.model.mark()
        const mark = t.mark()
        const timeline: { t: number; rows: string[] }[] = []
        let watching = true
        const watch = (async () => {
          let last = ""
          while (watching) {
            const shown = await t.screen().catch(() => "")
            const rows = shown.split("\n").filter((row) => telling.test(row))
            const state = t.summary().activity?.state ?? "none"
            rows.unshift(`[${state}]`)
            const key = rows
              .join("\n")
              .replace(/^.*\u2026 \(/gm, "(")
              .replace(/ · \d+s.*$/gm, "")
            if (key !== last) timeline.push({ t: Date.now(), rows })
            last = key
            await sleep(40)
          }
        })()
        await t.prompt("Hold on")
        if (!ownHook) {
          await run.model.waitFor((call) => !call.side && asked(call, "Hold on"), { after: marked })
          await t.reached("working", { after: mark })
        }
        const queueing = Date.now()
        await t.prompt("Queued beta")
        const beta = Date.now()
        await t.prompt("Queued gamma")
        const gamma = Date.now()
        await sleep(pause)
        const stopping = Date.now()
        const stopped = await t.interrupt()
        const back = Date.now()
        held.open()
        queuedHeld.open()
        await sleep(4000)
        watching = false
        await watch
        const seen = await t.screen()
        const hooks = readFileSync(hookLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { t: number; phase: string; input: string })
        results[`pause ${pause}`] = {
          times: { queueing, beta, gamma, stopping, back },
          stopped,
          hooks: hooks.map((hook) => ({ ...hook, t: hook.t - queueing })),
          calls: calls.map((call) => ({ ...call, t: call.t - queueing })),
          timeline: timeline.map((one) => ({ ...one, t: one.t - queueing })),
          screen: seen,
          state: t.summary().activity?.state,
        }
        writeFileSync(
          join(out, `${setup.agent}-queued-hooks.json`),
          JSON.stringify(results, null, 1),
        )
      }
    })
  })
}

// The screens Claude Code's profile reads for the hold, kept as a fixture.
describe.skipIf(!supported || !probing)("probe: Claude Code's queued screens", () => {
  const it = e2e.seeded({ promptHook: `node ${script}` }, claude)
  const long = `Queued long ${"word ".repeat(40).trim()}`
  it("each state", { timeout: 300_000 }, async ({ e2e: run }) => {
    const states: Record<string, unknown> = {}
    const take = async (t: Awaited<ReturnType<typeof start>>, name: string, shows: RegExp) => {
      await t.until(shows, 15_000)
      const read = await t.screenText()
      if (!read) throw new Error(`no screen for ${name}`)
      states[name] = screenRecord(read)
      writeFileSync(join(out, "queued-screens.json"), JSON.stringify({ states }, null, 1))
    }
    const hooks = /running UserPromptSubmit hook/
    const hint = /ctrl\+x ctrl\+s to send now/
    const held = async (t: Awaited<ReturnType<typeof start>>) => {
      const marked = run.model.mark()
      await t.prompt("Hold on")
      await run.model.waitFor((call) => !call.side && asked(call, "Hold on"), { after: marked })
    }
    let gates = gate()
    run.model.use(async (call) => {
      if (call.side) return undefined
      if (asked(call, "Hold on")) await gates.opened
      return { text: "Fine." }
    })

    const one = await start(run, claude)
    await held(one)
    await one.prompt("Queued beta")
    await one.prompt("Queued gamma")
    await sleep(150)
    await take(one, "running", hooks)
    await take(one, "through", hint)
    await one.interrupt()
    gates.open()

    gates = gate()
    const two = await start(run, claude)
    await held(two)
    await two.prompt(long)
    await two.prompt("Queued gamma\nits second line")
    await sleep(150)
    await take(two, "wrappedRunning", hooks)
    await take(two, "wrappedThrough", hint)
    await two.interrupt()
    gates.open()

    gates = gate()
    const three = await start(run, claude)
    await three.prompt("Hold on")
    await three.prompt("Queued beta")
    await three.prompt("Queued gamma")
    await sleep(150)
    await take(three, "ownHook", hint)
    gates.open()
  })
})
