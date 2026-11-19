// PROBE, not a test of Novadeck: whether Antigravity's own full-screen views (/help,
// /skills) hide a pending approval or question that arrives while they are open. A first
// run_command (sleep) is approved by the probe, the view is opened while it runs, then the
// next call (an approval, or ask_question) arrives. Screens go to
// $PROBE_OUT/agy-hidden-<name>.json.
// Run: PROBE_OUT=<dir> NOVADECK_E2E_PROBES=1 NOVADECK_E2E_AGENTS=agy pnpm -C backend/runner exec \
//   vitest run --config vitest.e2e.config.ts src/e2e/probes/agy-hidden-dialog.e2e.ts
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { agy } from "../agents/agy.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, supported, type E2E } from "../fixture.js"
import { asked, gate, type Call, type Reply } from "../model/script.js"
import { start } from "../scenarios.js"
import { sleep } from "./support.js"

const out = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")
mkdirSync(out, { recursive: true })
const it = e2e(agy)

const settled = async (t: DeckTerminal, forMs = 1000): Promise<string> => {
  let last = { shown: "", since: Date.now() }
  const until = Date.now() + 6000
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop -- Sampled in turn.
    const shown = await t.screen()
    if (shown !== last.shown) last = { shown, since: Date.now() }
    if (Date.now() - last.since >= forMs) return shown
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(100)
  }
  return last.shown
}

const rows = (screen: string) =>
  screenRecord(
    screen
      .split("\n")
      .filter((line) => line.trim() !== "")
      .join("\n"),
    { columns: 120 },
  )

type Kind = "command" | "question"
const second = (kind: Kind) =>
  kind === "command"
    ? {
        name: "run_command",
        input: { CommandLine: "echo approved", WaitMsBeforeAsync: 5000, toolSummary: "Echo" },
      }
    : {
        name: "ask_question",
        input: {
          questions: [
            {
              question: "Which colour?",
              options: ["Red", "Green", "Blue"],
              is_multi_select: false,
            },
          ],
        },
      }

const dialog = (kind: Kind) => (kind === "command" ? agy.approval!.shows : /> 1\. Red/)

type Scenario = {
  readonly name: string
  readonly kind: Kind
  readonly view: "/help" | "/skills"
  readonly close: string
  readonly closeLabel: string
}
const scenarios: Scenario[] = []
for (const kind of ["command", "question"] as const)
  for (const view of ["/help", "/skills"] as const)
    for (const [label, key] of [
      ["esc", "\x1b"],
      ["q", "q"],
    ] as const)
      scenarios.push({
        name: `${kind}-${view.slice(1)}-${label}`,
        kind,
        view,
        close: key,
        closeLabel: label,
      })

const only = process.env.HIDDEN_ONLY?.split(",")

describe.skipIf(!supported)("Antigravity hidden dialog (probe)", () => {
  for (const s of scenarios) {
    if (only && !only.some((o) => s.name.startsWith(o))) continue
    it(s.name, async ({ e2e: run }: { e2e: E2E }) => {
      const release = gate()
      const states: Record<string, unknown> = {}
      run.model.use(async (call: Call): Promise<Reply | undefined> => {
        if (call.side) return undefined
        const tools = call.turns.filter((turn) => turn.role === "tool").length
        if (asked(call, "Run the thing") && tools === 0)
          return {
            calls: [
              {
                name: "run_command",
                input: {
                  CommandLine: "sleep 9; echo slept",
                  WaitMsBeforeAsync: 30000,
                  toolSummary: "Sleep",
                },
              },
            ],
          }
        if (tools === 1) {
          await release.opened
          return { calls: [second(s.kind)] }
        }
        if (tools >= 2) return { text: "Finished the request." }
        return undefined
      })
      const t = await start(run, agy)
      await t.submit("Run the thing")
      await t.until(agy.approval!.shows, 30_000)
      states["0-first-approval"] = rows(await settled(t))
      t.press("1")
      await sleep(2500)
      states["1-running"] = rows(await settled(t))
      await t.submit(s.view)
      await sleep(2000)
      states["2-view-open"] = rows(await settled(t))
      release.open()
      // The sleep ends about 9 s after the approval; the dialog arrives then.
      await sleep(9000)
      states["3-view-after-arrival"] = rows(await settled(t))
      let detail = await t.detail()
      states["3-novadeck-sees"] = { activity: detail.activity, requests: detail.requests }
      t.press(s.close)
      await sleep(2500)
      states[`4-after-${s.closeLabel}`] = rows(await settled(t))
      detail = await t.detail()
      states["4-novadeck-sees"] = { activity: detail.activity, requests: detail.requests }
      t.press("\x1b")
      await sleep(2500)
      states["5-after-extra-esc"] = rows(await settled(t))
      writeFileSync(
        join(out, `agy-hidden-${s.name}.json`),
        JSON.stringify({ ...s, states }, null, 2),
      )
      void dialog
    })
  }
})
