import { spawnSync } from "node:child_process"
import { join } from "node:path"

import { workspacePackages } from "../../workspace/platform.ts"
import { invocations, testedFolders, turboTestArgs } from "./plan.ts"

// `node scripts/quality/plan/system-tests.ts`: the tests of every package that touches the
// system (`novadeck.platform`, scripts/workspace/platform.ts), as `Test (macOS)` and, for a
// change that affects only some of them, `Test (Windows)` run them on a pull request: on
// macOS one package at a time, elsewhere as the root's `test` (`invocations` in plan.ts).
// `NOVADECK_TEST_PACKAGES`, a JSON list of folders, narrows it (the plan's `packages`).
// `NOVADECK_TEST_CONTINUE=true`, as the proof rows set it, runs every package's tests though
// one fails (turbo's `--continue`), so one run shows each that fails. Extra arguments go to
// each package's test command.

const keepGoing = process.env.NOVADECK_TEST_CONTINUE === "true"

const packages = workspacePackages(join(import.meta.dirname, "..", "..", ".."))

for (const { folders, concurrency } of invocations(
  testedFolders(process.env.NOVADECK_TEST_PACKAGES, packages),
  process.platform,
)) {
  const result = spawnSync(
    "pnpm",
    ["exec", ...turboTestArgs({ folders, concurrency }, keepGoing, process.argv.slice(2))],
    { stdio: "inherit", shell: process.platform === "win32" },
  )
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    if (!keepGoing) break
  }
}
