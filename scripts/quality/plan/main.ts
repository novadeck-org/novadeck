import { appendFileSync } from "node:fs"
import { join } from "node:path"

import { facts, harnessIds } from "../../ci/plan/main.ts"
import { plan as graphPlan } from "../../ci/plan/plan.ts"
import { workspacePackages } from "../../workspace/platform.ts"
import { plan, proofRows, proves } from "./plan.ts"

// `node scripts/quality/plan/main.ts`: decides which systems Quality's tests run on, and which
// packages there, and prints the plan as JSON; in Actions it also sets the job's outputs
// `windows`, `macos`, `held`, `windows-rows`, `windows-packages`, `macos-rows` and `packages`,
// and `proof`, `proof-windows-rows` and `proof-macos-rows`: whether a pull request's run proves
// the narrowed rows (`proves`), and theirs.
// A draft (`DRAFT`) holds macOS back. What each system tests is scripts/ci/plan's: a pull
// request reads its changes from `BASE_SHA` and `HEAD_SHA` (the full history must be there),
// and so does a merge queue's group, its `merge_group.base_sha` and `head_sha` given as those;
// any other event, or anything that can't be read, runs every test on every system.

const root = join(import.meta.dirname, "..", "..", "..")

export const main = (): void => {
  const event = process.env.GITHUB_EVENT_NAME ?? ""
  const gathered = facts(event, process.env.BASE_SHA, process.env.HEAD_SHA)
  const graph = graphPlan(gathered, harnessIds())
  console.error(
    graph.everything === undefined
      ? `${event}: Windows tests ${graph.tests.windows.length} packages, macOS ${graph.tests.macos.length}`
      : `Everything runs: ${graph.everything}.`,
  )
  // Only a pull request's payload says so; a merge group, or anything else, runs macOS.
  const draft = event === "pull_request" && process.env.DRAFT === "true"
  const decided = plan({ tests: graph.tests, draft }, workspacePackages(root))
  const proof = event === "pull_request" && proves(gathered.files)
  console.log(JSON.stringify({ ...decided, proof }, null, 2))
  const output = process.env.GITHUB_OUTPUT
  if (output)
    appendFileSync(
      output,
      [
        `windows=${decided.windows}`,
        `macos=${decided.macos}`,
        `held=${decided.held}`,
        `windows-rows=${JSON.stringify(decided.windowsRows)}`,
        `windows-packages=${JSON.stringify(decided.windowsPackages)}`,
        `macos-rows=${JSON.stringify(decided.macosRows)}`,
        `packages=${JSON.stringify(decided.packages)}`,
        `proof=${proof}`,
        `proof-windows-rows=${JSON.stringify(proofRows("windows"))}`,
        `proof-macos-rows=${JSON.stringify(proofRows("macos"))}`,
        "",
      ].join("\n"),
    )
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
