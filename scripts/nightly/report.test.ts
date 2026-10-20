import { context, describe, expect, it } from "../test"
import { decide, titleOf, type Night } from "./report"

const run = (over: Partial<Night> = {}): Night => ({
  workflow: "E2E",
  conclusion: "failure",
  url: "https://github.com/o/r/actions/runs/1",
  attempt: 1,
  sha: "2b9eedc6ec776caa1e6f2b2dfdc747878ec4189c",
  startedAt: "2026-10-20T08:33:12Z",
  failed: [
    { name: "Mixed", conclusion: "failure", url: "https://github.com/o/r/actions/runs/1/job/3" },
    {
      name: "Antigravity",
      conclusion: "failure",
      url: "https://github.com/o/r/actions/runs/1/job/2",
    },
    {
      name: "Claude Code (macOS)",
      conclusion: "cancelled",
      url: "https://github.com/o/r/actions/runs/1/job/4",
    },
  ],
  ...over,
})

describe("a nightly run's report", () => {
  context("when a night fails and no issue is open", () => {
    it("opens one, titled for its workflow, naming each failed job by name", () => {
      const action = decide(run(), null)
      expect(action).toMatchObject({ kind: "open", title: "Nightly E2E is failing" })
      if (action.kind !== "open") return
      expect(action.body).toContain(
        "[E2E, 2026-10-20](https://github.com/o/r/actions/runs/1) on 2b9eedc6 failed.",
      )
      expect(action.body).toContain(
        [
          "3 jobs failed:",
          "",
          "- [Antigravity](https://github.com/o/r/actions/runs/1/job/2)",
          "- [Claude Code (macOS)](https://github.com/o/r/actions/runs/1/job/4) (cancelled)",
          "- [Mixed](https://github.com/o/r/actions/runs/1/job/3)",
        ].join("\n"),
      )
    })

    it("says what an E2E failure most likely is, and nothing of the kind for another workflow", () => {
      const e2e = decide(run(), null)
      const timing = decide(run({ workflow: "Benchmark Timing" }), null)
      expect(e2e.kind === "open" && e2e.body).toContain("harnesses.json")
      expect(timing).toMatchObject({ kind: "open", title: "Nightly Benchmark Timing is failing" })
      expect(timing.kind === "open" && timing.body).not.toContain("harness")
    })
  })

  it("adds to the issue still open when a night fails again", () => {
    expect(decide(run({ attempt: 2 }), 412)).toEqual({
      kind: "comment",
      issue: 412,
      body: expect.stringContaining("(attempt 2) on 2b9eedc6 failed.\n\n3 jobs failed:"),
    })
  })

  it("closes the issue on the first green night", () => {
    expect(decide(run({ conclusion: "success", failed: [] }), 412)).toEqual({
      kind: "close",
      issue: 412,
      body: "Green again: [E2E, 2026-10-20](https://github.com/o/r/actions/runs/1) on 2b9eedc6.",
    })
  })

  it("does nothing on a green night with no issue open", () => {
    expect(decide(run({ conclusion: "success", failed: [] }), null)).toEqual({ kind: "none" })
  })

  it("counts a run cancelled or timed out as failing, and one skipped as saying nothing", () => {
    expect(decide(run({ conclusion: "cancelled", failed: [] }), null)).toMatchObject({
      kind: "open",
      body: expect.stringContaining("The run ended `cancelled` with no job failed."),
    })
    expect(decide(run({ conclusion: "timed_out" }), 7)).toMatchObject({ kind: "comment", issue: 7 })
    expect(decide(run({ conclusion: "skipped" }), 7)).toEqual({ kind: "none" })
  })

  it("finds its issue again by the title it gave it", () => {
    expect(titleOf("E2E")).toBe("Nightly E2E is failing")
  })
})
