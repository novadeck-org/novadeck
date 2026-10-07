// Channel permission relay and MCP elicitation probes (launch flag needed: the dev channel).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { ScreenRecord } from "../../testing/probes.js"
import { claude } from "../agents/claude.js"
import { describe, e2e, supported } from "../fixture.js"
import { answers, own, result } from "../scenarios.js"
import { capture, install, sleep, snap, tweak } from "./claude-support.js"

const here = import.meta.dirname

describe.skipIf(!supported)("claude ask probe: channel relay and elicitation", () => {
  const it = e2e(claude)
  const run1 = (
    name: string,
    command: string,
    call: unknown,
    verdictFile: string | null,
    hook?: object,
  ) =>
    it(name, async ({ e2e: run }) => {
      const probe = install(run)
      const server = join(probe.dir, "server.mjs")
      copyFileSync(join(here, "claude-mcp-server.mjs"), server)
      writeFileSync(
        join(run.sandbox.project, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            probe: {
              command: "node",
              args: [server],
              env: { PROBE_DIR: probe.dir },
            },
          },
        }),
      )
      tweak(run, (s) => {
        s.enableAllProjectMcpServers = true
        s.permissions.allow.push("mcp__probe")
      })
      if (hook) probe.config("Elicitation", hook as never)
      const seen: { result?: string } = {}
      run.model.use(
        answers("Ask now", () => ({ calls: [call as never] })),
        own((c) => {
          const r = result(c)
          if (r === undefined) return undefined
          seen.result = r
          return { text: "Done." }
        }),
      )
      const t = await run.deck.open(command)
      await sleep(8000)
      const shots: Record<string, ScreenRecord> = { start: await snap(t) }
      // Dev-channel warning dialog, if shown.
      if (/Channels are not currently available/.test(await t.screen())) {
        // Probed 2026-10-06, 2.1.287: with an API key and the fake model the gate is closed,
        // so the channel (and its permission relay) can't be exercised here.
        capture(name, {
          shots,
          note: "channels not available in the sandbox",
        })
        return
      }
      if (/I am using this for local development/.test(await t.screen())) {
        shots.devDialog = await snap(t)
        await t.confirm(/I am using this for local development/, async () => {})
        await sleep(3000)
        shots.afterDev = await snap(t)
      }
      await t.submit("Ask now")
      await sleep(5000)
      shots.dialog = await snap(t)
      if (verdictFile) {
        writeFileSync(join(probe.dir, "verdict.any"), verdictFile)
        await sleep(4000)
        shots.afterVerdict = await snap(t)
      }
      capture(name, {
        shots,
        toolResult: seen.result,
        hooks: probe.log(),
        mcp: existsSync(join(probe.dir, "mcp.jsonl"))
          ? readFileSync(join(probe.dir, "mcp.jsonl"), "utf8")
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l))
          : [],
      })
    })

  const bash = {
    name: "Bash",
    input: { command: "touch chan.txt", description: "Run it" },
  }
  run1(
    "channel-relay-allow",
    "claude --dangerously-load-development-channels server:probe",
    bash,
    "allow",
  )
  run1("elicit-dialog", "claude", { name: "mcp__probe__elicit", input: {} }, null)
  run1("elicit-hook", "claude", { name: "mcp__probe__elicit", input: {} }, null, {
    now: {
      stdout: {
        hookSpecificOutput: {
          hookEventName: "Elicitation",
          action: "accept",
          content: { name: "Ada" },
        },
      },
    },
  })
})
