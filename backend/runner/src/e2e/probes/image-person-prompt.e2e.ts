// PROBE, not a test of Novadeck: what `personPrompt` (the prompt that started the person's turn, as
// the harness's hooks or transcript told it) holds for a prompt with an image, per harness. Runs
// only with NOVADECK_E2E_PROBES=1, by path. Writes $PROBE_OUT/<agent>-person-prompt.json.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, gate } from "../model/script.js"
import { picture } from "../pictures.js"
import { own, start } from "../scenarios.js"
import { probing } from "./support.js"

const outDir = process.env.PROBE_OUT ?? join(process.cwd(), "probe-out")

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(
    `probe: person prompt with an image in ${setup.name}`,
    () => {
      const it = e2e(setup)
      it("holds", async ({ e2e: run }) => {
        const held = gate()
        run.model.use(
          own(async (call) => {
            if (!asked(call, "fix this")) return undefined
            await held.opened
            return { text: "Done." }
          }),
        )
        const t1 = await start(run, setup)
        const mark = t1.mark()
        await t1.prompt("fix this", [{ name: "shot.png", data: picture }])
        await t1.reached("working", { after: mark })
        const asText = (await t1.screen()).split("\n").slice(-12).join("\n")
        mkdirSync(outDir, { recursive: true })
        writeFileSync(
          join(outDir, `${setup.agent}-person-prompt.json`),
          JSON.stringify({ person: await t1.personPrompt(), screen: asText }, null, 2),
        )
        held.open()
      })
    },
  )
}
