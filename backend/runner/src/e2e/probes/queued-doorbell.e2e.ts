// PROBE (#757): a real ring's line in Claude Code's queue as a Stop comes, a turn having
// started under it. Does the message it was ringing for still reach the agent? Runs only with
// NOVADECK_E2E_PROBES=1, by path; appends to $PROBE_OUT/doorbell.txt.
/* eslint-disable no-await-in-loop -- A probe's steps run in order. */
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import { doorbellLine } from "@novadeck/harness-core/prompts"

import { claude } from "../agents/claude.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { delivered, holds, own, sends, sent, start } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const out = process.env.PROBE_OUT ?? join(process.env.HOME ?? ".", "probe-out")
mkdirSync(out, { recursive: true })
const log = (line: string) => appendFileSync(join(out, "doorbell.txt"), `${line}\n`)

describe.skipIf(!supported || !probing)("probe: a ring's line queued", () => {
  const it = e2e(claude)
  it("as a Stop comes", { timeout: 120_000 }, async ({ e2e: run }) => {
    const held = gate()
    const started = Date.now()
    const order: string[] = []
    let got = false
    const note = (what: string) => log(`+${Date.now() - started} ${what}`)
    run.model.use(
      sends("Tell moth the news", "moth", "The build is green."),
      own((call) => (sent(call, "moth") ? { text: "Told moth." } : undefined)),
      own(async (call) => {
        if (call.side) return undefined
        const said = call.turns
          .flatMap((turn) => (turn.role === "user" ? [turn.text] : []))
          .join(" ")
        order.push(said.match(/Queued \w+( \d)?/g)?.join("+") ?? "none")
        if (delivered(call, "fox") && !got) {
          got = true
          note(`model got the message, queued in the call: ${said.includes("Queued")}`)
          return { text: "Noted the news." }
        }
        if (asked(call, "Carry on")) {
          note(`Carry on, with no message at the model`)
          return { text: "Carried on." }
        }
        if (asked(call, "Hold on")) {
          note("model call: Hold on")
          await held.opened
          return { text: "Too late." }
        }
        return undefined
      }),
    )
    const t1 = await start(run, claude)
    const t2 = await start(run, claude)
    const inside = run.deck.terminals as unknown as {
      live(id: string): { terminal: { pty: { write(data: string): void } } }
    }
    const variant = process.env.PROBE_VARIANT ?? "line"
    const { pty } = inside.live(t1.id).terminal
    const mark = t1.mark()
    await t1.prompt("Hold on")
    await t1.reached("working", { after: mark })
    await sleep(1500)
    await t2.submit("Tell moth the news")
    await t1.reached(holds("fox", "moth", "queued"))
    note("message waits, turn held")
    if (variant === "line") {
      pty.write(`\x1b[200~${doorbellLine("abc123def")}\x1b[201~`)
      await sleep(300)
      pty.write("\r")
    } else await t1.prompt("Queued beta")
    await sleep(2000)
    note(`queued row: ${(await t1.screen()).includes("Press up to edit queued messages")}`)
    // PROBE_VARIANT=plain: no Stop at all, the turn ending by itself; =keeps: and the person
    // queues another prompt into each turn that follows.
    if (variant === "plain" || variant === "keeps") {
      note("reply let go, no Stop")
      held.open()
      // eslint-disable-next-line no-unmodified-loop-condition -- `got` is set by the model.
      for (let i = 0; variant === "keeps" && i < 4 && !got; i++) {
        await sleep(1800)
        await t1
          .prompt(`Queued more ${i}`)
          .catch((error: unknown) => note(`prompt refused: ${String(error).slice(0, 80)}`))
        note(`queued more ${i}`)
      }
      await sleep(8_000)
      note(`calls: ${JSON.stringify(order)}`)
      return
    }
    const stopped = await t1.interrupt()
    note(`returned: ${JSON.stringify(stopped.returned ?? null)}`)
    held.open()
    // PROBE_NO_PROMPT=1: nothing more from the person: the doorbell alone must bring it.
    const noPrompt = process.env.PROBE_NO_PROMPT === "1"
    await sleep(noPrompt ? 30_000 : 12_000)
    if (!noPrompt) {
      // The next prompt: the agent should have the message by now, or get it with this.
      note("next prompt")
      await t1.prompt("Carry on")
      await sleep(6_000)
    }
    note(
      `after: box ${JSON.stringify(
        (await t1.screen())
          .split("\n")
          .filter((row) => row.trim())
          .slice(-4)
          .map((row) => row.slice(0, 50)),
      )}`,
    )
    note(
      `state ${t1.summary().activity?.state}, messages: ${JSON.stringify(t1.summary().activity?.state)}`,
    )
  })
})
