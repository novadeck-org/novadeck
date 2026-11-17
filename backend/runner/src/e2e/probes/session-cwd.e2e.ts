// PROBE, not a test of Novadeck: whether a harness's reports name the folder its agent `cd`ed
// into, which the terminal's folder follows, while the session's own stays where it bound.
// Each harness's agent runs `cd <project>/sub && pwd`, then a plain `pwd` (does its tool keep the
// folder?); then Claude Code and Codex compact (a SessionStart naming a `cwd`), and Antigravity's
// status line redraws as ever. Records the terminal's folder and the saved session's after each.
// Found 2026-11-17 (pinned: Claude Code 2.1.326, Codex 0.169.0, Antigravity 1.5.9): only Claude
// Code's Bash tool keeps the folder, and its compact's SessionStart names it, so the terminal's
// folder moves there while the session's stays; Codex's and Antigravity's commands each run in
// the session's folder again, and nothing they report moves. Runs only with
// NOVADECK_E2E_PROBES=1, by path; writes
// $PROBE_OUT/session-cwd-<agent>-<pinned|latest>.json.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { setups } from "../agents/index.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, supported } from "../fixture.js"
import { answers, own, result } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")

/** Submits `prompt`, allowing the command it runs where its harness asks first, as Antigravity does. */
const ran = async (t: DeckTerminal, prompt: string, times: number): Promise<void> => {
  await t.submit(prompt)
  await t.poll(
    async () => {
      const [request] = (await t.detail()).requests
      const dialog = request?.dialog
      if (dialog?.type === "choices") {
        const yes = dialog.options.find(
          (each) => each.label.startsWith("Yes") || /allow/i.test(each.label),
        )
        if (yes) await t.answer(request!.ref, { dialog: dialog.id, type: "choice", option: yes.id })
      }
      const shown = await t.screen()
      return (shown.match(/Ran it\./g)?.length ?? 0) >= times ? true : undefined
    },
    `"Ran it." ${times} times`,
    60_000,
  )
}

describe.skipIf(!supported || !probing)("probe: the folder a session reports after a cd", () => {
  for (const setup of setups)
    e2e(setup)(
      `${setup.name}`,
      async ({ e2e: run }) => {
        const sub = join(run.sandbox.project, "sub")
        mkdirSync(sub, { recursive: true })
        const outputs: string[] = []
        run.model.use(
          answers("Go below", (call) => setup.shell!.run(call, `cd ${sub} && pwd`)),
          answers("Where now", (call) => setup.shell!.run(call, "pwd")),
          own((call) => {
            const said = result(call)
            if (said === undefined) return undefined
            outputs.push(said.slice(0, 300))
            return { text: "Ran it." }
          }),
          () => ({ text: "Summary: nothing to keep." }),
        )
        const t = await run.deck.open(setup.agent)
        await t.reached("ready", { timeoutMs: 60_000 })
        const folders = () => ({
          terminal: t.summary().cwd,
          session: run.deck.store.terminal(t.id)?.agents[setup.agent]?.cwd,
        })
        const seen: Record<string, unknown> = { start: folders() }
        await ran(t, "Go below", 1)
        await sleep(3000)
        seen.afterCd = folders()
        await ran(t, "Where now", 2).catch(() => undefined)
        await sleep(3000)
        seen.afterPwd = folders()
        if (setup.agent !== "agy") {
          await t.submit("/compact")
          await sleep(15_000)
          seen.afterCompact = folders()
        }
        const version = process.env.NOVADECK_E2E_HARNESS === "latest" ? "latest" : "pinned"
        mkdirSync(outDir, { recursive: true })
        writeFileSync(
          join(outDir, `session-cwd-${setup.agent}-${version}.json`),
          JSON.stringify(
            { agent: setup.agent, version, project: run.sandbox.project, sub, outputs, seen },
            null,
            2,
          ),
        )
      },
      300_000,
    )
})
