import { cpSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked } from "../model/script.js"
import { own, start } from "../scenarios.js"

// PROBE, not a regression test: what Codex's hooks and rollout say about a patch applied
// through its shell (`apply_patch <<EOF`), which the fake model's Codex does in place of
// an apply_patch tool it is not offered. The rollouts go to PATCH_PROBE_OUT.
// Run: NOVADECK_E2E_PROBES=1 NOVADECK_E2E_AGENTS=codex pnpm --filter @novadeck/runner exec vitest run \
//   --config vitest.e2e.config.ts src/e2e/probes/codex-patch.e2e.ts

const out = process.env.PATCH_PROBE_OUT ?? join(tmpdir(), "codex-patch-probe")
const setup = setups.find((one) => one.agent === "codex")!

describe.skipIf(!supported)("Codex patch (probe)", () => {
  const it = e2e(setup)
  it("applies a patch through its shell", async ({ e2e: run }) => {
    const path = join(run.sandbox.project, "wrote.txt")
    run.model.use(
      own((call) =>
        asked(call, "Patch it") && call.turns.every((turn) => turn.role !== "tool")
          ? {
              calls: [
                {
                  name: "exec_command",
                  input: {
                    cmd: `apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: ${path}\n+x\n*** End Patch\nEOF`,
                    yield_time_ms: 5000,
                  },
                },
              ],
            }
          : call.turns.some((turn) => turn.role === "tool")
            ? { text: "Patched." }
            : undefined,
      ),
    )
    const t1 = await start(run, setup)
    await t1.submit("Patch it")
    await t1.until("Patched.")
    await new Promise((resolve) => setTimeout(resolve, 1500))
    cpSync(join(run.sandbox.home, ".codex"), out, { recursive: true, dereference: false })
  })
})
