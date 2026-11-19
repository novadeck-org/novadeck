// PROBE, not a test of Novadeck: how Claude Code's fullscreen renderer (`"tui": "fullscreen"`)
// shows a dialog that comes while the person has its transcript scrolled up. It stays below
// the view, and only a pill on the last row says it waits ("Waiting for your answer
// (ctrl+End) ↓"); ctrl+End scrolls it into view, and so does a digit, which answers nothing.
// For an AskUserQuestion and a Bash permission alike: each is held off-screen at 120×33, then
// at 49×32, scrolled into view with ctrl+End twice, scrolled away again with PageUp, and
// brought back with a digit, and hidden again for Escape; then asked again, hidden, and given Enter, scrolled in and answered with its own digit. Runs only with
// NOVADECK_E2E_PROBES=1, by path, once per version (NOVADECK_E2E_HARNESS); writes
// $PROBE_OUT/claude-fullscreen-scrolled-<version>.json, for
// harnesses/claude/src/fixtures/fullscreen-scrolled.probe.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { answers, own, result, start } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")
const setup = setups.find((each) => each.agent === "claude")!

const question = {
  question: "Should I merge it when it's green?",
  header: "Merge",
  multiSelect: false,
  options: [
    {
      label: "Merge when green (Recommended)",
      description: "Squash-merge it, pinned to its head.",
    },
    { label: "Leave it for me", description: "Get it green and report." },
  ],
}
const calls = {
  question: { name: "AskUserQuestion", input: { questions: [question] } },
  permission: {
    name: "Bash",
    input: { command: "touch made-by-probe.txt", description: "Make a file" },
  },
}
// A reply far taller than the screen, so PageUp leaves the view well above its end.
const tall = Array.from({ length: 120 }, (_, n) => `Line ${n + 1}: the text as it stands.`).join(
  "\n\n",
)
const PageUp = "\x1b[5~"
const CtrlEnd = "\x1b[1;5F"

describe.skipIf(!supported || !probing || !setup)(
  "probe: Claude Code's fullscreen dialog scrolled away",
  () => {
    e2e(setup)("draws its pill and scrolls the dialog into view", async ({ e2e: run }) => {
      const settings = join(run.sandbox.home, ".claude", "settings.json")
      writeFileSync(
        settings,
        JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), tui: "fullscreen" }),
      )
      let kind: keyof typeof calls = "question"
      let waited = false
      run.model.use(
        // A wait after the reply, for the probe to scroll up before the dialog comes.
        answers("Show the plan", () => ({
          text: tall,
          calls: [{ name: "Bash", input: { command: "sleep 8", description: "Wait" } }],
        })),
        own((call) => {
          const last = result(call)
          if (last === undefined) return undefined
          waited = !waited
          return waited ? { calls: [calls[kind]] } : { text: "Done." }
        }),
      )
      const t = await start(run, setup)
      const version = /Claude Code v(\d+\.\d+\.\d+)/.exec(await t.screen())?.[1] ?? "unknown"
      const states: Record<string, unknown> = {}
      const write = () => {
        mkdirSync(outDir, { recursive: true })
        writeFileSync(
          join(outDir, `claude-fullscreen-scrolled-${version}.json`),
          JSON.stringify({ version, facts: calls, states }, null, 2),
        )
      }
      const take = async (name: string, wait = 1_200) => {
        await sleep(wait)
        states[name] = screenRecord((await t.screenText())!)
        write()
      }

      // Each dialog twice: once moved about and set aside with Escape, once with Enter pressed
      // while hidden, then scrolled in and answered with its own digit.
      const hide = async () => {
        waited = false
        t.resize(120, 33)
        await sleep(800)
        await t.submit("Show the plan")
        await t.until(/Line 120:/, 30_000)
        await sleep(800)
        t.press(PageUp)
        await sleep(300)
        t.press(PageUp)
        await t.until(/Waiting for your answer/, 30_000)
      }
      for (kind of ["question", "permission"] as const) {
        await hide()
        await take(`${kind}Hidden`)
        t.resize(49, 32)
        await take(`${kind}HiddenNarrow`)
        t.resize(120, 33)
        await sleep(1_200)
        t.press(CtrlEnd)
        await take(`${kind}Revealed`)
        t.press(CtrlEnd)
        await take(`${kind}RevealedAgain`)
        t.press(PageUp)
        await take(`${kind}HiddenAgain`)
        t.press("1")
        await take(`${kind}DigitWhileHidden`)
        t.press(PageUp)
        await take(`${kind}HiddenForEscape`)
        await t.escape()
        await take(`${kind}EscapeWhileHidden`, 3_000)

        await hide()
        await take(`${kind}HiddenForEnter`)
        // Raw, as `press` refuses Enter where no dialog shows.
        run.deck.terminals.write({ terminalId: t.id, data: "\r" }, "e2e")
        await take(`${kind}EnterWhileHidden`, 2_000)
        t.press(CtrlEnd)
        await take(`${kind}AfterEnter`)
        if (/Enter to select|Esc to cancel/.test(await t.screen())) {
          t.press(kind === "question" ? "2" : "3")
          await take(`${kind}Answered`, 3_000)
        }
        await sleep(2_000)
      }

      write()
    })
  },
)
