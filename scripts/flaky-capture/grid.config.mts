import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import base from "../../application/ui/vitest.config.ts"

const root = fileURLToPath(new URL("../../application/ui/", import.meta.url))
const repo = fileURLToPath(new URL("../../", import.meta.url))
const output = process.env.NOVADECK_GRID_OUTPUT
if (!output) throw new Error("Run Grid capture through scripts/flaky-capture/grid.ts")
const behaviour = base.test.projects[1]

export default {
  ...base,
  root,
  // Vitest must read its retained trace back from the external artifact directory.
  server: { ...base.server, fs: { allow: [repo, output] } },
  test: {
    ...base.test,
    attachmentsDir: join(output, "attachments"),
    projects: [
      {
        ...behaviour,
        test: {
          ...behaviour.test,
          // Keep every preceding case and the original ordinary/one-move gestures.
          include: ["src/specs/companions.spec.tsx"],
          setupFiles: [
            ...behaviour.test.setupFiles,
            fileURLToPath(new URL("./grid.setup.mjs", import.meta.url)),
          ],
          browser: {
            ...behaviour.test.browser,
            screenshotFailures: true,
            trace: { mode: "retain-on-failure", tracesDir: join(output, "traces") },
            commands: {
              ...behaviour.test.browser.commands,
              gridCapture: async ({ page }, capture) => {
                if (!Number.isInteger(capture.index) || capture.index < 1 || capture.index > 100)
                  throw new Error("Invalid Grid capture case index")
                await writeFile(
                  join(output, `case-${String(capture.index).padStart(2, "0")}.json`),
                  `${JSON.stringify(capture, null, 2)}\n`,
                )
                await writeFile(
                  join(output, "browser.json"),
                  `${JSON.stringify({ version: page.context().browser()?.version(), viewport: page.viewportSize() }, null, 2)}\n`,
                )
              },
            },
          },
        },
      },
    ],
  },
}
