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
    // Since 0.163.0 its sandbox asks before the shell's patch writes: the chat allows each
    // request it asks, as the person would, until the turn says it patched.
    await t1.poll(
      async () => {
        const request = (await t1.detail()).requests.find((each) => !each.answered)
        const { dialog } = request ?? {}
        const yes = dialog?.type === "choices" ? dialog.options[0] : undefined
        if (request && dialog?.type === "choices" && yes?.label.startsWith("Yes"))
          await t1.answer(request.ref, { dialog: dialog.id, type: "choice", option: yes.id })
        return (await t1.screen()).includes("Patched.") ? true : undefined
      },
      "the patch to be applied",
      60_000,
    )
    await new Promise((resolve) => setTimeout(resolve, 1500))
    cpSync(join(run.sandbox.home, ".codex"), out, { recursive: true, dereference: false })
  })
})
