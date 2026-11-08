// PROBE, not a test of Novadeck (#757): what Claude Code is doing when a Stop's first Escape
// lands, its turn having ended during the hold. Three clocks side by side, all epoch ms: the
// screen's telling rows, from the Stop on; the prompt hook's start and end; and the
// `queue-operation` lines of its transcript. Runs only with NOVADECK_E2E_PROBES=1, by path;
// run it starved to hit the failure: see 383-queued-flake/starved.sh.
/* eslint-disable no-await-in-loop -- A probe's steps run in order. */
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { Interrupts } from "@novadeck/tui-input"

import { claude } from "../agents/claude.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { own, start } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const out = process.env.PROBE_OUT ?? join(process.env.HOME ?? ".", "probe-out")
mkdirSync(out, { recursive: true })
const reps = Number(process.env.PROBE_REPS ?? 3)
const hook = "slow-hook.cjs"
const hookLog = "slow-hook.log"

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })

describe.skipIf(!supported || !probing)("probe: a Stop's first Escape as its turn ends", () => {
  const it = e2e.seeded({ promptHook: hook }, claude)
  for (let rep = 0; rep < reps; rep++)
    it(`round ${rep}`, { timeout: 120_000 }, async ({ e2e: run }) => {
      const log = join(run.sandbox.project, hookLog)
      writeFileSync(
        join(run.sandbox.project, hook),
        `const { appendFileSync } = require("node:fs")
let input = ""
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  let prompt = ""
  try { prompt = JSON.parse(input).prompt ?? "" } catch {}
  const line = (phase) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ at: Date.now(), phase, prompt: prompt.slice(0, 20) }) + "\\n")
  line("start")
  process.on("SIGTERM", () => { line("killed"); process.exit(1) })
  setTimeout(() => { line("end"); console.log("{}") }, 1300)
})
`,
      )
      // PROBE_STOP_MS: a Stop hook that slow, widening the gap between a turn's end and the
      // next, as a slow shell does on Windows. It logs to the hook log, so that it ran shows.
      const stopMs = Number(process.env.PROBE_STOP_MS ?? 0)
      if (stopMs > 0) {
        writeFileSync(
          join(run.sandbox.project, "slow-stop.cjs"),
          `const { appendFileSync } = require("node:fs")
const line = (phase) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ at: Date.now(), phase, prompt: "Stop" }) + "\\n")
line("start")
setTimeout(() => { line("end"); console.log("{}") }, ${stopMs})
`,
        )
        mkdirSync(join(run.sandbox.project, ".claude"), { recursive: true })
        const stop = { hooks: [{ type: "command", command: "node slow-stop.cjs" }] }
        writeFileSync(
          join(run.sandbox.project, ".claude", "settings.local.json"),
          JSON.stringify({ hooks: { Stop: [stop] } }),
        )
      }
      const held = gate()
      const queuedHeld = gate()
      const events: { at: number; what: string }[] = []
      const note = (what: string) => events.push({ at: Date.now(), what })
      run.model.use(
        own(async (call) => {
          if (asked(call, "Queued")) {
            const last = call.turns.findLast((turn) => turn.role === "user")
            note(`model call: ${last && "text" in last ? last.text.slice(0, 70) : ""}`)
            await queuedHeld.opened
            return { text: "Queued late." }
          }
          if (!asked(call, "Hold on")) return undefined
          await held.opened
          note("model reply goes")
          return { text: "Too late." }
        }),
      )
      const t1 = await start(run, claude)
      const mark = t1.mark()
      await t1.prompt("Hold on")
      await t1.reached("working", { after: mark })
      await sleep(2000)
      // PROBE_NO_QUEUE=1: nothing queued at all, to see what Up does then.
      if (process.env.PROBE_NO_QUEUE !== "1") await t1.prompt("Queued beta")
      // PROBE_ENQUEUED=1: beta through its hook, and so in the real queue, before gamma comes.
      if (process.env.PROBE_ENQUEUED === "1") await t1.until(/to send now/)
      if (process.env.PROBE_NO_QUEUE !== "1") {
        await t1.prompt("Queued gamma")
        await t1.until(/running \w+ hook[\s\S]*Press up to edit queued messages/)
      }

      // The screen's rows that tell, whenever they change.
      let watching = true
      // The transcript's queue lines as this sees them, to tell how late one can be read.
      const queueFile = files(run.sandbox.root).find(
        (path) =>
          path.endsWith(".jsonl") && readFileSync(path, "utf8").includes('"queue-operation"'),
      )
      let seenLines = 0
      const watcher = (async () => {
        let last = ""
        // eslint-disable-next-line no-unmodified-loop-condition -- Set from outside the loop.
        while (watching) {
          if (queueFile) {
            const lines = readFileSync(queueFile, "utf8")
              .split("\n")
              .filter((line) => line.includes('"queue-operation"'))
            for (const line of lines.slice(seenLines)) {
              const row = JSON.parse(line) as { operation?: string; timestamp?: string }
              note(
                `read ${row.operation}, ${Date.now() - Date.parse(row.timestamp ?? "")} ms after its stamp`,
              )
            }
            seenLines = lines.length
          }
          const screen = await t1.screenText()
          const rows = (screen?.rows ?? [])
            .filter((row) =>
              /❯|Queued|hook|Interrupted|interrupted|\(\d+s|esc to|Press up/.test(row),
            )
            .map((row) => row.trim().slice(0, 90))
          const now = rows.join(" | ")
          if (now !== last) note(`screen: ${now}`)
          last = now
          await sleep(15)
        }
      })()
      // PROBE_DRAFT=1: the person has typed in the box meanwhile.
      if (process.env.PROBE_DRAFT === "1") {
        await t1.escape("my draft")
        await sleep(300)
        note("draft typed")
      }
      // PROBE_UP=1: Up first, as the box offers, the reply still held, to see what it takes
      // out of the queue; then the reply; then what the turn's end does with the rest.
      if (process.env.PROBE_UP === "1") {
        note("Up")
        t1.press("\x1b[A")
        // PROBE_RECALL_ESC=1: Up found no queue and recalled history: Escape, as a Stop would.
        if (process.env.PROBE_RECALL_ESC === "1") {
          await sleep(300)
          note("Escape over the recall")
          t1.press("\x1b")
          await sleep(1200)
          note(
            `then: ${(await t1.screen())
              .split("\n")
              .filter((row) => /History|^❯|Interrupted|\(\d+s/.test(row))
              .map((row) => row.trim().slice(0, 50))
              .join(" | ")}`,
          )
          note("Down")
          t1.press("\x1b[B")
          await sleep(1200)
          note(
            `then: ${(await t1.screen())
              .split("\n")
              .filter((row) => /History|^❯|Interrupted|\(\d+s/.test(row))
              .map((row) => row.trim().slice(0, 50))
              .join(" | ")}`,
          )
        }
        // PROBE_UP_ESC=1: as a Stop would go on: Escape once the box has them, the turn still
        // held, and the keys that clear the box. The reply is let go only after.
        if (process.env.PROBE_UP_ESC === "1") {
          for (let looks = 0; looks < 400; looks++) {
            const rows = (await t1.screenText())?.rows ?? []
            if (
              rows.some((row) => row.includes("Queued gamma")) &&
              !rows.some((row) => row.includes("Press up to edit"))
            )
              break
            await sleep(10)
          }
          note("Escape")
          t1.press("\x1b")
          await sleep(Number(process.env.PROBE_UP_MS ?? 1500))
          note("clear keys")
          t1.press("\x1b\x1b")
          await sleep(1500)
        } else await sleep(Number(process.env.PROBE_UP_MS ?? 2500))
        note("reply let go")
        held.open()
        await sleep(3000)
        watching = false
        await watcher
        queuedHeld.open()
        const rows = (await t1.screen())
          .split("\n")
          .filter((row) => row.trim())
          .slice(-9)
        for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
          const row = JSON.parse(line) as { at: number; phase: string; prompt: string }
          events.push({ at: row.at, what: `hook ${row.phase}: ${row.prompt}` })
        }
        events.sort((a, b) => a.at - b.at)
        const zero = events[0]?.at ?? 0
        appendFileSync(
          join(out, "cause.txt"),
          [
            "=== returned up",
            ...events.map(({ at, what }) => `+${String(at - zero).padStart(6)} ${what}`),
            ...rows,
            "",
          ].join("\n"),
        )
        return
      }
      note("Stop")
      // Each key the interrupt sends, as it goes.
      const proto = Interrupts.prototype as unknown as {
        once: (this: Keyed, ...args: unknown[]) => Promise<unknown>
      }
      type Keyed = {
        host: {
          type: (id: string, data: string) => boolean
          write: (id: string, data: string) => boolean
        }
      }
      const once = proto.once
      proto.once = function (...args) {
        const { type, write } = this.host
        this.host.type = (id, data) => {
          note(`typed ${JSON.stringify(data)}`)
          return type.call(this.host, id, data)
        }
        this.host.write = (id, data) => {
          note(`wrote ${JSON.stringify(data)}`)
          return write.call(this.host, id, data)
        }
        return once.apply(this, args)
      }
      const stopping = t1.interrupt().finally(() => {
        proto.once = once
      })
      await sleep(100)
      held.open()
      const stopped = await stopping
      note(`Stop returned ${JSON.stringify(stopped.returned)}`)
      await sleep(1500)
      watching = false
      await watcher
      queuedHeld.open()

      const summary = (await t1.screen())
        .split("\n")
        .filter((row) => row.trim())
        .slice(-8)
      const transcripts = files(run.sandbox.root).filter(
        (path) => path.endsWith(".jsonl") && readFileSync(path, "utf8").includes("queue-operation"),
      )
      for (const path of transcripts)
        for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
          const row = JSON.parse(line) as {
            type?: string
            operation?: string
            timestamp?: string
            content?: string
          }
          if (row.type === "queue-operation")
            events.push({
              at: Date.parse(row.timestamp ?? ""),
              what: `queue: ${row.operation} ${row.content ?? ""}`.slice(0, 80),
            })
        }
      for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
        const row = JSON.parse(line) as { at: number; phase: string; prompt: string }
        events.push({ at: row.at, what: `hook ${row.phase}: ${row.prompt}` })
      }
      events.sort((a, b) => a.at - b.at)
      const first = events[0]?.at ?? 0
      appendFileSync(
        join(out, "cause.txt"),
        [
          `=== returned ${JSON.stringify(stopped.returned)}`,
          ...events.map(({ at, what }) => `+${String(at - first).padStart(6)} ${what}`),
          ...summary,
          "",
        ].join("\n"),
      )
    })
})
