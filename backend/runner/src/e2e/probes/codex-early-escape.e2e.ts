// PROBE, not a test of Novadeck, and Linux only (`taskset`): whether a Stop's Escape can land
// before Codex's TUI knows its turn, as it did on macOS in the nightly of #690, and what the
// screen shows then. Its window is tens of milliseconds, so it takes a starved Codex to hit
// it: every thread of Codex shares one CPU with busy loops (SIGSTOP doesn't do, as the runner
// then counts the agent gone). Stop comes through the runner's own `interrupt` as soon as the
// runner hears the turn start. Runs only with NOVADECK_E2E_PROBES=1, by path; writes
// $PROBE_OUT/codex-early-escape.json with PROBE_ROUNDS rounds and PROBE_HOGS loops.
/* eslint-disable no-await-in-loop -- A probe's steps run in order. */
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { cpus, platform } from "node:os"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { codex } from "../agents/codex.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { own, start } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const out = process.env.PROBE_OUT ?? join(process.env.HOME ?? ".", "probe-out")
mkdirSync(out, { recursive: true })
const rounds = Number(process.env.PROBE_ROUNDS ?? 25)
const hogs = Number(process.env.PROBE_HOGS ?? 6)
const row = /to interrupt\)/

const save = (name: string, data: unknown) =>
  writeFileSync(join(out, name), `${JSON.stringify(data, null, 2)}\n`)

/** The Codexes of this sandbox, the TUI first and any it left running a command after it. */
const codexes = (): readonly number[] => {
  const cache = process.env.NOVADECK_E2E_CACHE!
  const found = execFileSync("ps", ["-eo", "pid=,comm=,args="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match) => match?.[2] === "codex" && match[3]!.includes(cache))
  return found.map((match) => Number(match![1])).toSorted((a, b) => a - b)
}

describe.skipIf(!supported || !probing || platform() !== "linux")("probe: Codex early Stop", () => {
  const it = e2e(codex)

  it("screens of a turn at normal speed", { timeout: 300_000 }, async ({ e2e: run }) => {
    const never = gate()
    const long = Array.from({ length: 5000 }, (_, i) => `Line ${i} of a long reply.`).join("\n")
    run.model.use(
      own(async (call) => {
        if (asked(call, "Take your time")) {
          await never.opened
          return { text: "Too late." }
        }
        if (asked(call, "Say a lot")) return { text: long }
        return undefined
      }),
    )
    const t1 = await start(run, codex)
    const states: Record<string, ReturnType<typeof screenRecord>> = {}
    const take = async (name: string) => {
      const screen = await t1.screenText()
      if (screen) states[name] = screenRecord(screen)
    }
    await take("ready")

    // A long reply: its row gives way to the text as it streams, the turn running on. It looks
    // as fast as it can, as those few moments fall between `poll`'s looks.
    let mark = t1.mark()
    await t1.prompt("Say a lot")
    await t1.reached("working", { after: mark })
    for (let looks = 0; states.streaming === undefined && looks < 5000; looks++) {
      const screen = await t1.screenText()
      const reply = screen?.rows.some((one) => one.includes("of a long reply"))
      const over = screen?.rows.some((one) => row.test(one) || one.includes("Worked for"))
      if (screen && reply && !over) states.streaming = screenRecord(screen)
      else if (over && reply) break
    }
    await t1.reached("settled", { after: mark })
    await take("afterTurn")

    // A prompt of several lines, working: the row under it.
    mark = t1.mark()
    await t1.prompt("Take your time\nwith these\nthree lines")
    await t1.until(row, 30_000)
    await take("working")
    await t1.interrupt()
    await sleep(1500)
    await take("interrupted")
    never.open()
    save("codex-early-escape-states.json", states)
  })

  it(
    `Stop as the turn starts, ${hogs} loops on its CPU`,
    { timeout: 900_000 },
    async ({ e2e: run }) => {
      const never = gate()
      run.model.use(
        own(async (call) => {
          if (asked(call, "Leave a terminal"))
            return {
              calls: [{ name: "exec_command", input: { cmd: "sleep 600", yield_time_ms: 500 } }],
            }
          if (!asked(call, "Take your time")) return undefined
          await never.opened
          return { text: "Too late." }
        }),
      )
      const t1 = await start(run, codex)
      // A command an earlier turn left running draws its own row above the box while no
      // status row is up, as when the turn isn't yet known.
      if (process.env.PROBE_BACKGROUND === "1") {
        const mark = t1.mark()
        await t1.prompt("Leave a terminal")
        await t1.reached("settled", { after: mark })
        await t1.until(/background terminal running/, 30_000)
      }
      const cpu = cpus().length - 1
      execFileSync("taskset", ["-a", "-c", "-p", String(cpu), String(codexes()[0])], {
        stdio: "ignore",
      })
      const loops: ChildProcess[] = []
      for (let i = 0; i < hogs; i++) {
        const loop = ["-c", String(cpu), "sh", "-c", "while :; do :; done"]
        loops.push(spawn("taskset", loop, { stdio: "ignore" }))
      }
      const results: unknown[] = []
      try {
        for (let i = 0; i < rounds; i++) {
          const mark = t1.mark()
          // Every third prompt takes several rows, which only its words tell from a reply's.
          await t1.prompt(`Take your time ${i}${i % 3 === 2 ? "\nwith these\nthree lines" : ""}`)
          await t1.reached("working", { after: mark })
          const seen = await t1.screenText()
          const started = Date.now()
          await t1.interrupt()
          const tookMs = Date.now() - started
          await sleep(2500)
          const screen = await t1.screen()
          const lost = /Working \(/.test(screen)
          results.push({
            round: i,
            lost,
            tookMs,
            row: seen?.rows.some((one) => row.test(one)) ?? false,
            seen: seen && screenRecord(seen),
          })
          save("codex-early-escape.json", results)
          if (lost) {
            await t1.escape()
            await sleep(2000)
          }
        }
      } finally {
        for (const loop of loops) loop.kill("SIGKILL")
        for (const left of codexes().slice(1)) process.kill(left, "SIGKILL")
        never.open()
      }
    },
  )
})
