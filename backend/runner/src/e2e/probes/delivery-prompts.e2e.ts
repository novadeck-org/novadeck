// PROBE, not a test of Novadeck: the prompts each harness submits, as its prompt hook or
// its transcript's typed input tells them, while Novadeck delivers agents' messages: a ring
// of an idle agent, whose prompt is the doorbell's line, and a Stop Novadeck continues with a
// message. Whatever of a delivery reaches a prompt is what `promptStart` must tell from the
// person's own words. Runs only with NOVADECK_E2E_PROBES=1, by path; writes
// `delivery-prompts-<agent>.json` to PROBE_OUT.
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

import { harnesses } from "../../harnesses/registry.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { delivered, holds, own, sends, sent, start } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const out = process.env.PROBE_OUT ?? join(process.env.HOME ?? ".", "probe-out")
mkdirSync(out, { recursive: true })
const hook = "prompt-log.cjs"
const log = "prompt-log.jsonl"

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    try {
      return statSync(path).isDirectory() ? files(path) : [path]
    } catch {
      return []
    }
  })

// The lines of every file under `root` named `name`.
const linesOf = (root: string, name: RegExp): string[] =>
  files(root)
    .filter((path) => name.test(path))
    .flatMap((path) => readFileSync(path, "utf8").split("\n").filter(Boolean))

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(
    `probe: ${setup.name}'s prompts beside deliveries`,
    () => {
      const it = e2e.seeded({ promptHook: hook }, setup)
      it(
        "records the prompts a ring and a continued Stop submit",
        { timeout: 180_000 },
        async ({ e2e: run }) => {
          const logPath = join(run.sandbox.project, log)
          writeFileSync(
            join(run.sandbox.project, hook),
            `const { appendFileSync } = require("node:fs")
let input = ""
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  let payload = {}
  try { payload = JSON.parse(input) } catch {}
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ at: Date.now(), event: payload.hook_event_name ?? null, prompt: payload.prompt ?? null }) + "\\n")
  console.log("{}")
})
`,
          )
          const ending = gate()
          run.model.use(
            sends("Tell moth the news", "moth", "The build is green."),
            sends("Ask fox for its colour", "fox", "What is your colour?"),
            own((call) =>
              sent(call, "moth") || sent(call, "fox") ? { text: "Sent." } : undefined,
            ),
            own((call) => (delivered(call, "fox") ? { text: "Noted the news." } : undefined)),
            own((call) => (delivered(call, "moth") ? { text: "Noted the question." } : undefined)),
            own(async (call) => {
              if (call.side || !asked(call, "Hold then stop")) return undefined
              await ending.opened
              return { text: "First done." }
            }),
          )
          const t1 = await start(run, setup)
          const t2 = await start(run, setup)
          // A Stop continued with a message: t1 works while t2 sends to it.
          const mark = t1.mark()
          await t1.submit("Hold then stop")
          await t1.reached("working", { after: mark })
          await t2.submit("Tell moth the news")
          await t1.reached(holds("fox", "moth", "queued"), { after: mark })
          ending.open()
          await t1.until("Noted the news.")
          await t1.reached("settled", { after: mark })
          // A ring: t2 is idle when t1 sends to it.
          const mark2 = t2.mark()
          await t2.reached("settled", { after: mark2 }).catch(() => undefined)
          await t1.submit("Ask fox for its colour")
          await t2.until("Noted the question.")
          await sleep(3000)

          const hooked = (() => {
            try {
              return readFileSync(logPath, "utf8")
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line))
            } catch {
              return []
            }
          })()
          const harness = harnesses[setup.agent]
          const typed =
            harness.messaging.typedEntry === undefined
              ? []
              : linesOf(run.sandbox.root, /transcript_full\.jsonl$/).flatMap((line) => {
                  const entry = harness.messaging.typedEntry!(line)
                  return entry ? [entry.text] : []
                })
          // Every transcript line that holds a delivery, by its kind: where in the records it lands.
          const records = linesOf(run.sandbox.root, /\.jsonl$/)
            .filter((line) => line.includes("novadeck-messages"))
            .map((line) => {
              const at = line.indexOf("novadeck-messages")
              return line.slice(Math.max(0, at - 300), at + 40)
            })
          const record = { agent: setup.agent, hooked, typed, records }
          writeFileSync(
            join(out, `delivery-prompts-${setup.agent}.json`),
            JSON.stringify(record, null, 2),
          )
          appendFileSync(
            join(out, "delivery-prompts.log"),
            `${setup.agent}: ${hooked.length} prompts\n`,
          )
        },
      )
    },
  )
}
