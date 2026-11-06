import { cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

import { describe, e2e, supported } from "../fixture.js"
import { setupOf, stepsIn, takeSteps, variants } from "../outcomes.js"
import { sleep } from "./support.js"

// PROBE, not a regression test: what each harness records of a tool call's outcome, every
// step of outcomes.ts. Every record, the tools it offered and the screen go to
// TOOL_OUTCOMES_OUT, a folder per variant, from which `tool-outcomes.probe.json` was taken.
// Run: NOVADECK_E2E_PROBES=1 pnpm --filter @novadeck/runner exec vitest run \
//   --config vitest.e2e.config.ts src/e2e/probes/tool-outcomes.e2e.ts

const out = process.env.TOOL_OUTCOMES_OUT ?? join(tmpdir(), "tool-outcomes-probe")

const records = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((one) => one.isFile() && one.name.endsWith(".jsonl"))
    .map((one) => join(one.parentPath, one.name))

for (const variant of variants) {
  const setup = setupOf(variant)
  describe.skipIf(!supported)(`Tool outcomes (probe): ${variant.name}`, () => {
    const it = e2e(setup)
    it("records each step", { timeout: 300_000 }, async ({ e2e: run }) => {
      const dir = join(out, variant.name)
      mkdirSync(dir, { recursive: true })
      variant.prepare(run)
      let offered: readonly string[] = []
      const terminal = await takeSteps(run, setup, stepsIn(variant, run), (call) => {
        offered = call.tools
      })
      await sleep(2000)
      writeFileSync(join(dir, "tools.json"), JSON.stringify(offered, null, 2))
      writeFileSync(join(dir, "screen.txt"), await terminal.screen())
      for (const file of records(run.sandbox.home)) {
        const target = join(dir, relative(run.sandbox.home, file))
        mkdirSync(dirname(target), { recursive: true })
        cpSync(file, target)
      }
    })
  })
}
