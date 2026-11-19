// PROBE, not a test of Novadeck: how Codex's `/diff` pager hides a dialog that comes while it
// is open. The pager takes the whole screen (a `/ D I F F / / /` header, `~` filler, a rule
// with `100%`, a scroll hint, ` q close`), and nothing on it says a dialog waits: an approval
// (`exec_command` with `require_escalated`) or a `request_user_input` question, asked while
// a command runs and the pager is open, is drawn under it. `q` closes the pager and shows the
// dialog, still pending; Escape does not close it but answers the hidden dialog (it cancels
// the approval, which ends the turn interrupted, or skips the question). Records the pager
// with the approval held, after `q`, and after Escape, the same for a question (in Plan mode),
// and a pager with no request. Runs only with NOVADECK_E2E_PROBES=1 and
// NOVADECK_E2E_AGENTS=codex, by path, once per version; writes
// $PROBE_OUT/codex-hidden-dialog-<version>.json, for
// harnesses/codex/src/fixtures/hidden-dialog.probe.json (paths in it scrubbed).
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { setups } from "../agents/index.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate, type Call, type Reply } from "../model/script.js"
import { prompted } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")
const setup = setups.find((each) => each.agent === "codex")!

const questions = {
  questions: [
    {
      id: "color",
      header: "Color",
      question: "Which color should the button be?",
      options: [
        { label: "Blue (Recommended)", description: "The house color." },
        { label: "Green", description: "Calmer." },
      ],
    },
  ],
}

const calls = {
  permission: {
    name: "exec_command",
    input: {
      cmd: "echo approved > probe-out.txt",
      sandbox_permissions: "require_escalated",
      justification: "Echo outside the sandbox",
    },
  },
  question: { name: "request_user_input", input: questions },
}

const states: Record<string, unknown> = {}
let version = "unknown"
const write = () => {
  mkdirSync(outDir, { recursive: true })
  // The sandbox's folders are the machine's, not the fixture's.
  const text = JSON.stringify({ version, facts: calls, states }, null, 2).replace(
    /\/tmp\/novadeck-e2e-\w+/g,
    "/tmp/work",
  )
  writeFileSync(join(outDir, `codex-hidden-dialog-${version}.json`), text)
}

describe.skipIf(!supported || !probing || !setup)(
  "probe: Codex's /diff pager over a dialog",
  () => {
    const it = e2e(setup)
    const settled = async (t: DeckTerminal, forMs = 800): Promise<void> => {
      let last = { shown: "", since: Date.now() }
      const until = Date.now() + 4_000
      while (Date.now() < until) {
        const shown = await t.screen()
        if (shown !== last.shown) last = { shown, since: Date.now() }
        if (Date.now() - last.since >= forMs) return
        await sleep(100)
      }
    }

    for (const [kind, escape] of [
      ["permission", false],
      ["question", false],
      ["plain", false],
      ["permission", true],
      ["question", true],
    ] as const) {
      const name = `${kind}${escape ? "Escape" : ""}`
      it(`${name}: the pager over what is pending`, async ({ e2e: run }) => {
        const release = gate()
        run.model.use(async (call: Call): Promise<Reply | undefined> => {
          if (call.side) return undefined
          const tools = call.turns.filter((turn) => turn.role === "tool").length
          if (asked(call, "Run the thing") && tools === 0)
            return {
              calls: [
                {
                  name: "exec_command",
                  input: { cmd: "sleep 8; echo slept", yield_time_ms: 30_000 },
                },
              ],
            }
          if (tools === 1 && kind !== "plain") {
            await release.opened
            return { calls: [calls[kind]] }
          }
          if (tools >= 1) return { text: "Finished the request." }
          return undefined
        })
        const t = await run.deck.open("codex")
        await t.reached("ready", { timeoutMs: 60_000 })
        await prompted(t, setup)
        version = /OpenAI Codex \(v(\d+\.\d+\.\d+)\)/.exec(await t.screen())?.[1] ?? version
        const take = async (state: string, wait = 1_500) => {
          await sleep(wait)
          await settled(t)
          states[`${name}${state}`] = screenRecord((await t.screenText())!)
          write()
        }
        if (kind === "question") {
          await t.submit("/plan")
          await t.until(/Plan mode/, 20_000)
          await settled(t)
        }
        await t.prompt("Run the thing")
        await sleep(3_000)
        await t.submit("/diff")
        await take("Open")
        release.open()
        // The command ends about 8 s after it began, and the dialog is asked then.
        await sleep(9_000)
        await take("Held")
        if (escape) {
          // Not a way out of the pager: it answers what is under it.
          await t.escape()
          await take("AfterEscape", 3_000)
        } else {
          t.press("q")
          await take("AfterQ", 2_000)
        }
        write()
      })
    }
  },
)
