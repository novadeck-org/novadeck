import { describe, expect, it } from "vitest"

import {
  publishJob,
  superseded,
  supersede,
  type GitHub,
  type Job,
  type ReleaseRun,
} from "./main.ts"

const newer = { headSha: "b".repeat(40), createdAt: "2026-11-24T12:00:40Z" }

const older = (overrides: Partial<ReleaseRun> = {}): ReleaseRun => ({
  id: 1,
  event: "push",
  status: "queued",
  createdAt: "2026-11-24T11:59:50Z",
  headSha: "a".repeat(40),
  ...overrides,
})

// As the API listed run 45389277046 while its macOS package waited for a runner.
const packaging: Job[] = [
  { name: "Prepare", status: "completed" },
  { name: "Package / Linux", status: "completed" },
  { name: "Package / Windows", status: "completed" },
  { name: "Package / macOS", status: "queued" },
  { name: "Package / Scope", status: "completed" },
]

const done = packaging.map((job) => ({ ...job, status: "completed" }))

describe("superseded", () => {
  it("cancels an older push's run while it packages", () => {
    expect(superseded(older(), packaging, newer)).toBe(true)
    expect(superseded(older({ status: "in_progress" }), packaging, newer)).toBe(true)
  })

  it("cancels one still preparing", () => {
    expect(superseded(older(), [{ name: "Prepare", status: "in_progress" }], newer)).toBe(true)
  })

  it("leaves a run that publishes, or is about to", () => {
    expect(superseded(older(), [...done, { name: publishJob, status: "queued" }], newer)).toBe(
      false,
    )
    expect(superseded(older(), done, newer)).toBe(false)
  })

  it("leaves a run by hand, which releases a version its commits don't call for", () => {
    expect(superseded(older({ event: "workflow_dispatch" }), packaging, newer)).toBe(false)
  })

  it("leaves the newest push's own run, and any run started after this one", () => {
    expect(superseded(older({ headSha: newer.headSha }), packaging, newer)).toBe(false)
    expect(superseded(older({ createdAt: "2026-11-24T12:05:00Z" }), packaging, newer)).toBe(false)
  })

  it("leaves pending and finished runs", () => {
    expect(superseded(older({ status: "pending" }), packaging, newer)).toBe(false)
    expect(superseded(older({ status: "completed" }), packaging, newer)).toBe(false)
  })
})

describe("supersede", () => {
  const github = (
    runs: ReleaseRun[],
    jobs: Record<number, Job[]>,
    cancelled: number[],
  ): GitHub => ({
    releaseRuns: async () => runs,
    jobs: async (runId) => jobs[runId] ?? [],
    cancel: async (runId) => {
      cancelled.push(runId)
    },
  })

  it("cancels only the runs a newer push supersedes", async () => {
    const cancelled: number[] = []
    const runs = [
      older({ id: 3, status: "pending", createdAt: newer.createdAt, headSha: newer.headSha }),
      older({ id: 2 }),
      older({ id: 1, status: "in_progress" }),
      older({ id: 0, status: "completed" }),
    ]
    const jobs = { 1: [...done, { name: publishJob, status: "in_progress" }], 2: packaging }
    const result = await supersede(newer, github(runs, jobs, cancelled), { log: () => {} })
    expect(result).toEqual([2])
    expect(cancelled).toEqual([2])
  })

  it("cancels nothing on a dry run", async () => {
    const cancelled: number[] = []
    const lines: string[] = []
    const result = await supersede(newer, github([older({ id: 2 })], { 2: packaging }, cancelled), {
      dryRun: true,
      log: (line) => lines.push(line),
    })
    expect(result).toEqual([2])
    expect(cancelled).toEqual([])
    expect(lines).toEqual(["Would cancel run 2 (aaaaaaaaa)."])
  })
})
