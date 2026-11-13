import { readFileSync } from "node:fs"

import { context, describe, expect, it } from "../test"
import { nightOf } from "./main"
import { decide } from "./report"

// The Actions API as gh answers it, for one run whose own name is its title (e2e.yml's
// `run-name`, since #881) and so differs from its workflow's name, as #881 found.
const api =
  (run: Record<string, unknown>) =>
  (...args: string[]): string => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? ""
    if (path.includes("/attempts/") && path.endsWith("/jobs?per_page=100"))
      return JSON.stringify([{ jobs: [] }])
    if (path.includes("/attempts/")) return JSON.stringify(run)
    if (path.endsWith("/actions/workflows/7")) return JSON.stringify({ name: "E2E" })
    throw new Error(`unexpected: ${args.join(" ")}`)
  }

const run = (name: string, event: string) => ({
  workflow_id: 7,
  name,
  event,
  conclusion: "failure",
  html_url: "https://github.com/o/r/actions/runs/1",
  head_sha: "2b9eedc6ec776caa1e6f2b2dfdc747878ec4189c",
  run_started_at: "2026-11-13T02:17:44Z",
})

describe("a nightly run read for its report", () => {
  process.env.GITHUB_REPOSITORY = "o/r"

  context("when the run's own name is its title, not its workflow's", () => {
    it("names E2E's pinned night by its workflow, as its issue is found", () => {
      const night = nightOf("1", 1, api(run("E2E on the pinned harnesses", "workflow_dispatch")))
      expect(night.workflow).toBe("E2E (pinned)")
    })

    it("names E2E's own night so it adds to the issue already open, not a second one", () => {
      const night = nightOf("1", 1, api(run("E2E on the latest harnesses", "schedule")))
      expect(night.workflow).toBe("E2E")
      expect(decide(night, null)).toMatchObject({ title: "Nightly E2E is failing" })
    })
  })

  it("is chosen in nightly.yml by its workflow's name, never by the run's", () => {
    const workflow = readFileSync(".github/workflows/nightly.yml", "utf8")
    expect(workflow).toContain("github.event.workflow.name == 'E2E'")
    expect(workflow).not.toMatch(/workflow_run\.name\b/)
  })
})
