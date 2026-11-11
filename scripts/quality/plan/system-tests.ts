import { spawnSync } from "node:child_process"
import { join } from "node:path"

import { workspacePackages } from "../../workspace/platform.ts"
import { filters, testedFolders } from "./plan.ts"

// `node scripts/quality/plan/system-tests.ts`: the tests of every package that touches the
// system (`novadeck.platform`, scripts/workspace/platform.ts), one package at a time, as
// `Test (macOS)` runs them on a pull request. One at a time: a macOS runner has three cores, and the packages' real
// processes, PTYs and wall-clock bounds failed there when 23 packages ran at once (#784).
// `NOVADECK_TEST_PACKAGES`, a JSON list of folders, narrows it (the plan's `packages`). Extra
// arguments go to each package's test command.

const packages = workspacePackages(join(import.meta.dirname, "..", "..", ".."))

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "turbo",
    "run",
    "test",
    "--output-logs=new-only",
    "--concurrency=1",
    ...filters(testedFolders(process.env.NOVADECK_TEST_PACKAGES, packages)),
    "--",
    "--reporter=default",
    "--reporter=hanging-process",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
)
process.exitCode = result.status ?? 1
