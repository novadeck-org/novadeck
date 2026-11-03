// PROBE, not a test of Novadeck: which release each harness says wrote a session, and where.
// Claude Code writes `version` among the keys that close its conversation records (not its
// bookkeeping ones) and in its status line; Codex writes `cli_version` in the rollout's first
// record; Antigravity writes `version` in its status line, and nothing per conversation (its
// hooks and its brain folder name none). Runs only with NOVADECK_E2E_PROBES=1, by path;
// writes $PROBE_OUT/<agent>.version.probe.json, the sample of those records that
// `harnesses/<agent>/src/fixtures/version.probe.json` keeps, scrubbed of the sandbox's paths and ids.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Report } from "@novadeck/harness-core/report"

import type { HookAnswer } from "../../shell/reports.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { replies, start } from "../scenarios.js"

const out = process.env.PROBE_OUT

type Inside = {
  reporting: { report: (report: Report, deadline?: number) => Promise<HookAnswer> }
}

/** The sessions' JSONL files under `root`. */
const jsonl = (root: string): string[] => {
  try {
    return readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".jsonl") && !/history|chunks/.test(name))
      .map((name) => join(root, name))
  } catch {
    return []
  }
}

for (const setup of setups) {
  describe.skipIf(!out || !supported)(`probe: version in ${setup.name}`, () => {
    const it = e2e(setup)
    it("shows the release in the session's own records", async ({ e2e: run }) => {
      const inside = run.deck.terminals as unknown as Inside
      const report = inside.reporting.report
      const reports: { event: string; payload: Record<string, unknown> }[] = []
      inside.reporting.report = async function (incoming, deadline) {
        reports.push({ event: incoming.event, payload: incoming.payload })
        return report.call(this, incoming, deadline)
      }
      run.model.use(replies("Version probe", "Version probe done."))
      const terminal = await start(run, setup)
      await terminal.prompt("Version probe")
      await terminal.poll(
        async () => ((await terminal.screen()).includes("Version probe done.") ? true : undefined),
        "its reply",
        60_000,
      )
      await new Promise((resolve) => setTimeout(resolve, 3000))
      const scrub = (value: string): string =>
        value
          .replaceAll(run.sandbox.root, "/home/user")
          .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
      const stores = { claude: ".claude/projects", codex: ".codex/sessions", agy: ".gemini" }
      // Antigravity's files name no version, so none is kept.
      const files = setup.agent === "agy" ? [] : jsonl(join(run.sandbox.home, stores[setup.agent]))
      const lines = files.flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => ({ file: file.slice(run.sandbox.home.length), line })),
      )
      const record = {
        harness: setup.agent,
        source: "captured",
        how: "the reports a terminal's hooks and status line gave the runner, and the lines of the session file the harness wrote, in one reply of the e2e suite against the fake model",
        reports: reports
          .filter((each) => /StatusLine/.test(each.event))
          .map((each) => JSON.parse(scrub(JSON.stringify(each.payload))) as unknown),
        // Each distinct kind of line once, a long one cut to its end, where a version stands.
        lines: [
          ...new Map(
            lines.map(({ line }) => [
              (JSON.parse(line) as { type?: string; payload?: { type?: string } }).type +
                String((JSON.parse(line) as { payload?: { type?: string } }).payload?.type),
              line,
            ]),
          ).values(),
        ].map((line) =>
          scrub(
            line.length > 1500 && setup.agent !== "codex"
              ? `…${line.slice(-700)}`
              : line.slice(0, 2500),
          ),
        ),
      }
      mkdirSync(out!, { recursive: true })
      writeFileSync(
        join(out!, `${setup.agent}.version.probe.json`),
        JSON.stringify(record, null, 2),
      )
    })
  })
}
