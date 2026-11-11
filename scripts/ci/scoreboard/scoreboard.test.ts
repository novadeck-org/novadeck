import { readFileSync, readdirSync } from "node:fs"

import { context, describe, expect, it } from "../../test"
import {
  compute,
  osOf,
  percentile,
  render,
  type Job,
  type Run,
  type Scoreboard,
} from "./scoreboard"

// Recorded API responses, trimmed to the fields the scoreboard reads: the run list of a week
// (two Quality runs that were rerun, a third that was not, a cancelled macOS job, and a
// dependabot run among them) and the jobs of every attempt of each run but dependabot's.
const fixtures = new URL("./fixtures/", import.meta.url)
const runs = (
  JSON.parse(readFileSync(new URL("runs.json", fixtures), "utf8")) as { workflow_runs: Run[] }
).workflow_runs
const jobs = readdirSync(new URL("jobs/", fixtures)).flatMap(
  (file) =>
    (
      JSON.parse(readFileSync(new URL(`jobs/${file}`, fixtures), "utf8")) as {
        jobs: Job[]
      }
    ).jobs,
)

const row = (board: Scoreboard, workflow: string, job: string) =>
  board.jobs.find((entry) => entry.workflow === workflow && entry.job === job)

describe("the CI scoreboard of a recorded week", () => {
  const board = compute(runs, jobs, 7)

  context("counting runs", () => {
    it("leaves out dependabot's and counts the runs that went past their first attempt", () => {
      expect(runs).toHaveLength(9)
      expect(board.workflows).toEqual([
        { workflow: "E2E", runs: 4, reruns: 2, share: 0.5 },
        { workflow: "Quality", runs: 4, reruns: 3, share: 0.75 },
      ])
    })
  })

  context("a job whose first attempt failed in some runs", () => {
    it("rates the first attempts that finished and counts the runs that needed a rerun", () => {
      // Windows 1/3 failed first in 1 of 4 runs and passed on the rerun.
      expect(row(board, "Quality", "Test (Windows, 1/3)")).toEqual({
        workflow: "Quality",
        job: "Test (Windows, 1/3)",
        os: "Windows",
        finished: 4,
        passRate: 0.75,
        cancelled: 0,
        rerun: 1,
      })
      // Windows 2/3 failed first in 2 of 4, and both passed on a rerun.
      expect(row(board, "Quality", "Test (Windows, 2/3)")).toMatchObject({
        finished: 4,
        passRate: 0.5,
        rerun: 2,
      })
    })

    it("does not count a failure that no later attempt passed as a rerun", () => {
      // Test (macOS) failed first once; its rerun was cancelled.
      expect(row(board, "Quality", "Test (macOS)")).toMatchObject({
        finished: 4,
        passRate: 0.75,
        cancelled: 0,
        rerun: 0,
      })
    })

    it("shows the jobs that fail most first within a workflow", () => {
      expect(board.jobs.find((entry) => entry.workflow === "Quality")?.job).toBe(
        "Test (Windows, 2/3)",
      )
    })
  })

  context("a job that ran in a cancelled run", () => {
    it("counts its cancelled first attempt apart from the pass rate", () => {
      expect(row(board, "E2E", "Codex (macOS)")).toEqual({
        workflow: "E2E",
        job: "Codex (macOS)",
        os: "macOS",
        finished: 0,
        passRate: null,
        cancelled: 1,
        rerun: 0,
      })
    })
  })

  context("the rows that are not jobs of their own", () => {
    it("leaves out skipped rows, matrix placeholders and gate jobs", () => {
      const names = board.jobs.map((entry) => entry.job)
      expect(names.filter((name) => /\$\{\{|matrix\./.test(name))).toEqual([])
      for (const gate of ["Test", "E2E", "Plan", "Package"]) expect(names).not.toContain(gate)
      expect(names).not.toContain("Probes (${{ matrix.setup.name }})")
    })
  })

  context("the Macs", () => {
    it("sums the hours the executed macOS jobs of all attempts ran, cancelled ones included, over the days", () => {
      // 14 executed macOS jobs, 3.661 hours, 0.665 of them in cancelled jobs.
      expect(board.macHoursPerDay).toBeCloseTo(3.661 / 7, 3)
      expect(board.macCancelledHoursPerDay).toBeCloseTo(0.665 / 7, 3)
    })

    it("does not count the jobs a rerun lists without running them again", () => {
      // The second attempts of Quality runs 42293091494 and 42658823397 list their macOS test
      // again with the first attempt's times; counted, they would add two jobs to these 14.
      const queue = board.queues.find((entry) => entry.os === "macOS")
      expect(queue?.jobs).toBe(14)
    })

    it("takes the queue p90 of macOS jobs beside Linux and Windows", () => {
      const [mac, linux, windows] = board.queues
      expect(mac).toEqual({ os: "macOS", jobs: 14, p90: 25.8 })
      expect(linux?.os).toBe("Linux")
      expect(linux?.jobs).toBe(49)
      expect(linux?.p90).toBeLessThan(0.2)
      expect(windows?.os).toBe("Windows")
      expect(windows?.jobs).toBe(33)
      expect(windows?.p90).toBeLessThan(0.2)
    })
  })

  context("a draft whose gate jobs fail on purpose", () => {
    it("takes no pass or failure from the gates or from the run's conclusion", () => {
      const draft: Run = { ...runs[0]!, id: 1, conclusion: "failure" }
      const gate = (name: string): Job => ({
        run_id: 1,
        run_attempt: 1,
        name,
        labels: ["ubuntu-latest"],
        conclusion: "failure",
        created_at: "2026-11-02T10:00:00Z",
        started_at: "2026-11-02T10:00:01Z",
        completed_at: "2026-11-02T10:00:05Z",
      })
      const macOS: Job = {
        ...gate("Test (macOS)"),
        labels: ["macos-latest"],
        conclusion: "skipped",
      }
      const lint: Job = { ...gate("Lint"), conclusion: "success" }
      const drafted = compute([draft], [gate("Test"), gate("E2E"), macOS, lint], 7)
      expect(drafted.jobs).toEqual([
        {
          workflow: "Quality",
          job: "Lint",
          os: "Linux",
          finished: 1,
          passRate: 1,
          cancelled: 0,
          rerun: 0,
        },
      ])
    })
  })

  context("rendered for a job summary", () => {
    const markdown = render(board)

    it("has a table of workflows, one of jobs and the Macs' hours and queue", () => {
      expect(markdown).toContain("| Quality | 4 | 3 | 75.0% |")
      expect(markdown).toContain("| Quality | Test (Windows, 2/3) | Windows | 50.0% | 4 | 0 | 2 |")
      expect(markdown).toContain("| E2E | Codex (macOS) | macOS | n/a | 0 | 1 | 0 |")
      expect(markdown).toContain("macOS job-hours a day: **0.5**")
      expect(markdown).toContain("| macOS | 14 | 25.8 |")
    })
  })
})

describe("the macOS hours of a window", () => {
  const run: Run = {
    id: 1,
    name: "Quality",
    event: "pull_request",
    conclusion: "success",
    created_at: "2026-11-02T10:00:00Z",
    run_attempt: 1,
    actor: { login: "someone" },
  }
  const mac = (over: Partial<Job>): Job => ({
    run_id: 1,
    run_attempt: 1,
    name: "Test (macOS)",
    labels: ["macos-latest"],
    conclusion: "success",
    created_at: "2026-11-02T10:00:00Z",
    started_at: "2026-11-02T10:10:00Z",
    completed_at: "2026-11-02T10:40:00Z",
    ...over,
  })

  it("is the executed minutes over the days, a cancelled job's among them", () => {
    const board = compute(
      [run],
      [
        mac({}),
        mac({ conclusion: "cancelled", completed_at: "2026-11-02T11:40:00Z" }),
        mac({ conclusion: "skipped", started_at: "2026-11-02T10:00:00Z" }),
      ],
      2,
    )
    // 30 + 90 minutes over 2 days.
    expect(board.macHoursPerDay).toBe(1)
    expect(board.macCancelledHoursPerDay).toBe(0.75)
  })

  it("is nothing without macOS jobs", () => {
    expect(compute([run], [], 7)).toMatchObject({ macHoursPerDay: 0, jobs: [] })
  })
})

describe("a system read from a job", () => {
  it("comes from its labels, then its name", () => {
    expect(osOf({ labels: ["macos-latest"], name: "Test" })).toBe("macOS")
    expect(osOf({ labels: ["windows-latest"], name: "Test" })).toBe("Windows")
    expect(osOf({ labels: ["ubuntu-24.04"], name: "Test" })).toBe("Linux")
    expect(osOf({ labels: [], name: "Codex (macOS)" })).toBe("macOS")
    expect(osOf({ labels: [], name: "Package" })).toBe("other")
  })
})

describe("a percentile", () => {
  it("is the nearest rank, to a tenth", () => {
    expect(percentile([5, 1, 3, 2, 4, 9, 8, 7, 6, 10], 90)).toBe(9)
    expect(percentile([1.26], 90)).toBe(1.3)
    expect(percentile([], 90)).toBeNull()
  })
})
