// PROBE: what Claude Code's PostToolUse hook says of a CronCreate and a CronDelete, which
// `scheduleChange` (terminals/schedules.ts) matches by id: where the cron's id is in the
// create's result, and that the delete's input names the same one. Runs only with
// NOVADECK_E2E_PROBES=1, by path; with PROBE_OUT set it writes $PROBE_OUT/cron-id.probe.json
// (the tools' declarations and every hook payload of the two calls).
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { claude } from "../agents/claude.js"
import { describe, e2e, expect, supported } from "../fixture.js"
import type { Call } from "../model/script.js"
import { answers, own, prompted, result } from "../scenarios.js"
import { install } from "./claude-support.js"
import { sleep } from "./support.js"

describe.skipIf(!supported || process.env.NOVADECK_E2E_PROBES === undefined)(
  "probe: cron ids in Claude Code's tool hooks",
  () => {
    const it = e2e(claude)
    it("names the cron in the result of its create", async ({ e2e: run }) => {
      const probe = install(run)
      const found: Record<string, unknown> = {}
      const offered = (call: Call): void => {
        found.tools = call.tools.filter((name) => /Cron/.test(name))
        found.declarations = (call.rawTools ?? []).filter((tool) =>
          /Cron/.test(JSON.stringify(tool).slice(0, 200)),
        )
      }
      let created: string | undefined
      run.model.use(
        answers("Schedule a cron", (call) => {
          offered(call)
          return {
            calls: [
              {
                name: "CronCreate",
                input: { cron: "7 * * * *", prompt: "check in", recurring: true },
              },
            ],
          }
        }),
        own((call) => {
          const text = result(call)
          if (text === undefined) return undefined
          const turns = call.turns.filter((turn) => turn.role === "tool").length
          if (turns === 1) {
            created = text
            // The id as the result tells it, whatever it is called there.
            const id = /\b([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}|[0-9a-f]{8,})\b/i.exec(text)?.[1]
            return { calls: [{ name: "CronDelete", input: { id: id ?? "unknown" } }] }
          }
          return { text: "Done." }
        }),
      )
      const terminal = await run.deck.open("claude")
      await terminal.reached("ready", { timeoutMs: 60_000 })
      await prompted(terminal, claude)
      await terminal.submit("Schedule a cron")
      await terminal.until("Done.", 60_000)
      await sleep(1000)
      found.createResult = created
      found.created = probe
        .payloads("PostToolUse")
        .filter((p) => (p as { tool_name?: string }).tool_name === "CronCreate")
      found.deleted = probe
        .payloads("PostToolUse")
        .filter((p) => (p as { tool_name?: string }).tool_name === "CronDelete")
      const out = process.env.PROBE_OUT
      if (out) {
        mkdirSync(out, { recursive: true })
        writeFileSync(join(out, "cron-id.probe.json"), JSON.stringify(found, null, 2))
      }
      const [made] = found.created as { tool_response?: { id?: string } }[]
      const [gone] = found.deleted as { tool_input?: { id?: string } }[]
      // What scheduleChange relies on: an id there, the one the delete names.
      expect(made?.tool_response?.id).toEqual(expect.stringMatching(/\S/))
      expect(gone?.tool_input?.id).toBe(made?.tool_response?.id)
    })
  },
)
