// PROBE, not a test of Novadeck: what each harness records, and tells its hooks, of what changes
// between turns: its permission or approval mode, plan mode and a plan's approval, and a
// compaction. Each key press and command is one step, with a prompt after it so the record has a
// reason to write. Runs only with NOVADECK_E2E_PROBES=1, by path; PROBE_ONLY picks steps. Writes
// $PROBE_OUT/<agent>-modes.json: the screen at each step, and the record's lines as written.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { start } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")
const shiftTab = "\x1b[Z"

type Step = { readonly label: string; readonly keys?: string; readonly submit?: string }

// What is pressed, in order; a prompt follows each so a mode shows in what the record writes.
const steps: Readonly<Record<string, readonly Step[]>> = {
  claude: [
    { label: "first prompt", submit: "First words" },
    { label: "shift-tab 1", keys: shiftTab },
    { label: "prompt after 1", submit: "After one" },
    { label: "shift-tab 2", keys: shiftTab },
    { label: "prompt after 2", submit: "After two" },
    { label: "shift-tab 3", keys: shiftTab },
    { label: "prompt after 3", submit: "After three" },
    { label: "shift-tab 4", keys: shiftTab },
    { label: "prompt after 4", submit: "After four" },
    { label: "compact", submit: "/compact" },
    { label: "prompt after compact", submit: "After compacting" },
  ],
  codex: [
    { label: "first prompt", submit: "First words" },
    { label: "shift-tab 1", keys: shiftTab },
    { label: "prompt after 1", submit: "After one" },
    { label: "shift-tab 2", keys: shiftTab },
    { label: "prompt after 2", submit: "After two" },
    { label: "compact", submit: "/compact" },
    { label: "prompt after compact", submit: "After compacting" },
  ],
  agy: [
    { label: "first prompt", submit: "First words" },
    { label: "shift-tab 1", keys: shiftTab },
    { label: "prompt after 1", submit: "After one" },
    { label: "shift-tab 2", keys: shiftTab },
    { label: "prompt after 2", submit: "After two" },
    { label: "compact", submit: "/compact" },
    { label: "prompt after compact", submit: "After compacting" },
  ],
}

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: mode notes in ${setup.name}`, () => {
    const it = e2e(setup)

    it("what it records", async ({ e2e: run }) => {
      run.model.use(() => ({ text: "Noted." }))
      const t = await start(run, setup)
      const raw = (data: string) => run.deck.terminals.write({ terminalId: t.id, data }, "e2e")
      const seen: unknown[] = []
      for (const step of steps[setup.agent] ?? []) {
        if (step.keys) raw(step.keys)
        if (step.submit) await t.submit(step.submit)
        await sleep(step.submit ? 4000 : 1500)
        const rows = (await t.screen()).split("\n").filter((row) => row.trim() !== "")
        seen.push({ label: step.label, end: rows.slice(-6) })
      }
      const files = execSync(
        `find ${run.sandbox.root} -type f \\( -name '*.jsonl' -o -name '*.json' \\) | grep -v node_modules | head -60`,
      )
        .toString()
        .split("\n")
        .filter(Boolean)
      const lines = files
        .filter((file) =>
          /session|rollout|projects|brain|conversation|overview|transcript/i.test(file),
        )
        .map((file) => ({
          file: file.replace(run.sandbox.root, ""),
          text: readFileSync(file, "utf8")
            .split("\n")
            .filter(
              (line) => !/"type":"(?:api-request|api-request-blob|api-request-shape)"/.test(line),
            )
            .join("\n"),
        }))
      const detail = await t.detail()
      mkdirSync(outDir, { recursive: true })
      writeFileSync(
        join(outDir, `${setup.agent}-modes.json`),
        JSON.stringify({ seen, lines, activity: detail.activity }, null, 1),
      )
    })
  })
}
