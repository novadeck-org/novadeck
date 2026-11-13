import { describe, expect, it } from "../../test"
import { mergeQueueBar } from "./bar"
import { runsOf } from "./main"
import { compute, type Job } from "./scoreboard"

// The Actions API as gh answers it: the repository's workflows, and E2E's runs, whose own
// names are their titles (e2e.yml's `run-name`, since #881): a pull request's title, or the
// harnesses a dispatch ran. The other workflows have no runs here.
const workflows = [
  { id: 1, name: "Quality" },
  { id: 2, name: "E2E" },
  { id: 3, name: "Nightly Quality" },
]
const e2eRuns: Record<string, unknown[]> = {
  pull_request: [
    {
      id: 10,
      name: "feat(ui): a pane of its own",
      event: "pull_request",
      conclusion: "success",
      created_at: "2026-11-12T10:00:00Z",
      run_attempt: 2,
      actor: { login: "someone" },
    },
  ],
  workflow_dispatch: [
    {
      id: 11,
      name: "E2E on the pinned harnesses",
      event: "workflow_dispatch",
      conclusion: "success",
      created_at: "2026-11-12T23:43:17Z",
      run_attempt: 1,
      actor: { login: "github-actions[bot]" },
    },
  ],
}
const gh = (...args: string[]): string => {
  const path = args.find((arg) => arg.startsWith("repos/")) ?? ""
  if (path.includes("/actions/workflows?")) return JSON.stringify([{ workflows }])
  const event = /event=(\w+)/.exec(path)?.[1] ?? ""
  const runs = path.includes("/actions/workflows/2/runs") ? (e2eRuns[event] ?? []) : []
  return JSON.stringify([{ workflow_runs: runs }])
}

const job = (attempt: number, conclusion: string): Job => ({
  run_id: 10,
  run_attempt: attempt,
  name: "Codex (1/2)",
  labels: ["ubuntu-latest"],
  conclusion,
  created_at: `2026-11-12T1${attempt}:00:00Z`,
  started_at: `2026-11-12T1${attempt}:00:01Z`,
  completed_at: `2026-11-12T1${attempt}:05:00Z`,
})

describe("the runs the scoreboard reads", () => {
  const since = Date.parse("2026-11-12T00:00:00Z")
  const runs = runsOf("o/r", since, since + 86_400_000, gh)

  it("go by their workflow's name, not their own titles", () => {
    expect(runs.map((run) => [run.id, run.name])).toEqual([
      [10, "E2E"],
      [11, "E2E"],
    ])
  })

  it("count an E2E run titled by its pull request, and the pinned night, in the bar", () => {
    const bar = mergeQueueBar(runs, [job(1, "failure"), job(2, "success")])
    expect(bar.e2e).toEqual({ finished: 1, failed: 1, flaky: 1 })
    expect(bar.pinnedE2e).toEqual({ green: 1, total: 1 })
  })

  it("group an E2E run titled by its pull request under E2E in the tables", () => {
    const board = compute(runs, [job(1, "failure"), job(2, "success")], 1)
    expect(board.jobs.map((row) => [row.workflow, row.job])).toEqual([["E2E", "Codex (1/2)"]])
  })
})
