import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { adapterFolder } from "../../testing/adapters.js"
import { setups } from "../agents/index.js"
import { describe, e2e, supported } from "../fixture.js"
import { installHarness } from "../install.js"
import { answers, own, result, running, start } from "../scenarios.js"
import { sleep } from "./support.js"

// PROBE, not a test of Novadeck: how each harness draws a permission for a command far
// taller than its screen, and for two such commands that start and end alike asked at once,
// and what Novadeck reads of it. The pinned release writes each harness's
// fixtures/tall.probe.json; TALL_PROBE_OUT sends any other run's somewhere else to compare.
//
// Run: NOVADECK_E2E_PROBES=1 pnpm --filter @novadeck/runner exec vitest run \
//   --config vitest.e2e.config.ts src/e2e/probes/tall-approval.e2e.ts

const out = process.env.TALL_PROBE_OUT

// Tall, past what a dialog's detail once took, and with what a script holds: blank lines,
// indents, tabs, quotes and more than ASCII. It only writes files in the sandbox's project.
const script = (name: string): string =>
  [
    `cat <<'E' > ${name}.txt`,
    ...Array.from({ length: 170 }, (_, n) =>
      n % 25 === 24
        ? ""
        : `${n % 3 === 0 ? "    " : ""}("row ${n}", 'of a tall command', "… and more")${n % 7 === 0 ? "\tend" : ""}`,
    ),
    "E",
    `touch ${name}-done.txt`,
  ].join("\n")
const wide = `${Array.from({ length: 170 }, (_, n) => `touch row-${n}`).join(" && ")} && touch end`

const scrub = <T>(value: T, root: string): T =>
  JSON.parse(JSON.stringify(value).replaceAll(root, "/sandbox")) as T

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)
    const captured: Record<string, unknown> = {}

    for (const [name, commands] of [
      ["tall", [script("tall")]],
      ["wide", [wide]],
      ["twins", [script("twin"), `${script("twin")}\necho the second`]],
    ] as const) {
      it(`draws ${name}`, async ({ e2e: run }) => {
        run.model.use(
          answers("Make the file", (call) => running(setup.approval!.request(call), ...commands)),
          own((call) => (result(call) !== undefined ? { text: "Noted." } : undefined)),
        )
        const t = await start(run, setup)
        await t.prompt("Make the file")
        await t.until(setup.approval!.shows)
        await sleep(4000)
        const big = screenRecord((await t.screenText())!)
        t.resize(60, 20)
        await sleep(2500)
        const small = screenRecord((await t.screenText())!)
        const seen = { commands, screens: { "120x40": big, "60x20": small } }
        captured[name] = scrub(seen, run.sandbox.root)
        const names = { version: (await installHarness(setup.agent)).version }
        const folder = out ?? join(adapterFolder(setup.agent), "fixtures")
        mkdirSync(folder, { recursive: true })
        writeFileSync(
          join(folder, out ? `${setup.agent}-tall.json` : "tall.probe.json"),
          `${JSON.stringify({ ...names, scenarios: captured }, null, 2)}\n`,
        )
      })
    }
  })
}
