import { readFileSync } from "node:fs"

import { parseRegister } from "../flakes/match"
import { context, describe, expect, it } from "../test"
import { decide, nameOf, titleOf, verdictOf, type Night } from "./report"

const register = parseRegister(JSON.parse(readFileSync("scripts/flakes/register.json", "utf8")))
// A Test (macOS) log that failed as a known flake did, and one as a flake registered fixed.
const knownLog = readFileSync("scripts/flakes/fixtures/ui-agents-pinned-drag-top.txt", "utf8")
const fixedLog = readFileSync("scripts/flakes/fixtures/ui-companions-plan-reopen-place.txt", "utf8")
const brokenLog = knownLog.replace(
  "still reorders the list when dragged to its top",
  "keeps its pins in order",
)
const job = (id: number, name: string, log?: string) => ({
  id,
  name,
  conclusion: "failure",
  url: `https://github.com/o/r/actions/runs/1/job/${id}`,
  ...(log === undefined ? {} : { verdict: verdictOf(register, name, log) }),
})

const run = (over: Partial<Night> = {}): Night => ({
  workflow: "E2E",
  conclusion: "failure",
  url: "https://github.com/o/r/actions/runs/1",
  attempt: 1,
  sha: "2b9eedc6ec776caa1e6f2b2dfdc747878ec4189c",
  startedAt: "2026-10-20T08:33:12Z",
  failed: [
    {
      id: 3,
      name: "Mixed",
      conclusion: "failure",
      url: "https://github.com/o/r/actions/runs/1/job/3",
    },
    {
      id: 2,
      name: "Antigravity",
      conclusion: "failure",
      url: "https://github.com/o/r/actions/runs/1/job/2",
    },
    {
      id: 4,
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
      expect(action).toMatchObject({
        kind: "open",
        title: "Nightly E2E is failing",
      })
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
      expect(timing).toMatchObject({
        kind: "open",
        title: "Nightly Benchmark Timing is failing",
      })
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
    expect(decide(run({ conclusion: "success", failed: [] }), null)).toEqual({
      kind: "none",
    })
  })

  it("counts a run cancelled or timed out as failing, and one skipped as saying nothing", () => {
    expect(decide(run({ conclusion: "cancelled", failed: [] }), null)).toMatchObject({
      kind: "open",
      body: expect.stringContaining("The run ended `cancelled` with no job failed."),
    })
    expect(decide(run({ conclusion: "timed_out" }), 7)).toMatchObject({
      kind: "comment",
      issue: 7,
    })
    expect(decide(run({ conclusion: "skipped" }), 7)).toEqual({ kind: "none" })
  })

  it("finds its issue again by the title it gave it", () => {
    expect(titleOf("E2E")).toBe("Nightly E2E is failing")
  })

  it("names a workflow already named for its night only once", () => {
    expect(titleOf("Nightly Quality")).toBe("Nightly Quality is failing")
  })

  it("reports E2E's pinned run apart from its own night, under its own title", () => {
    expect(nameOf("E2E", "schedule")).toBe("E2E")
    expect(nameOf("E2E", "workflow_dispatch")).toBe("E2E (pinned)")
    expect(nameOf("Nightly Quality", "workflow_dispatch")).toBe("Nightly Quality")
    const pinned = decide(run({ workflow: "E2E (pinned)" }), null)
    expect(pinned).toMatchObject({
      kind: "open",
      title: "Nightly E2E (pinned) is failing",
    })
    expect(pinned.kind === "open" && pinned.body).toContain("not a harness's drift")
  })

  it("says what a failed Nightly Quality most likely is", () => {
    const action = decide(run({ workflow: "Nightly Quality" }), null)
    expect(action).toMatchObject({
      kind: "open",
      title: "Nightly Quality is failing",
    })
    expect(action.kind === "open" && action.body).toContain("passed on its pull request")
    expect(action.kind === "open" && action.body).not.toContain("harnesses.json")
  })

  context("when the failed jobs' logs were read against the known-flake register", () => {
    it("says a night of known flakes only is flaky, naming each flake under its job", () => {
      const action = decide(
        run({
          workflow: "Nightly Quality",
          failed: [job(5, "Test (macOS)", knownLog)],
        }),
        null,
      )
      expect(action.kind === "open" && action.body).toContain(
        [
          "1 job failed:",
          "",
          "- [Test (macOS)](https://github.com/o/r/actions/runs/1/job/5)",
          "  - Known flake: `ui-agents-pinned-drag-top`",
          "",
          "**Every failure is a registered known flake** (`scripts/flakes/register.json`): a flaky night, not a break.",
        ].join("\n"),
      )
    })

    it("names a failed test no flake explains, and calls the night a break", () => {
      const action = decide(
        run({
          workflow: "Nightly Quality",
          failed: [job(5, "Test (macOS)", knownLog), job(6, "Test (Linux, 1/3)", brokenLog)],
        }),
        7,
      )
      expect(action.kind === "comment" && action.body).toContain(
        [
          "- [Test (Linux, 1/3)](https://github.com/o/r/actions/runs/1/job/6)",
          "  - Not explained: `src/specs/agents.spec.tsx > A pinned project > dragged from the switcher menu > keeps its pins in order, with the bar behind it`",
          "- [Test (macOS)](https://github.com/o/r/actions/runs/1/job/5)",
          "  - Known flake: `ui-agents-pinned-drag-top`",
        ].join("\n"),
      )
      expect(action.kind === "comment" && action.body).toContain(
        "**A failure no registered flake explains**",
      )
    })

    it("tells a flake registered as fixed coming back apart from a known one", () => {
      const action = decide(run({ failed: [job(5, "Test (macOS)", fixedLog)] }), 7)
      expect(action.kind === "comment" && action.body).toContain(
        "  - Fixed flake back: `ui-companions-plan-reopen-place`",
      )
      expect(action.kind === "comment" && action.body).toContain(
        "**A flake registered as fixed is back**",
      )
    })

    it("says why a job names no test, as one stopped at its time limit, and marks a log not read", () => {
      const action = decide(
        run({
          failed: [
            {
              ...job(
                5,
                "Test (Windows, 2/3)",
                "Run Test (Windows, 2/3)\n##[error]The operation was canceled.\n",
              ),
              conclusion: "cancelled",
            },
            job(6, "Test (Linux, 3/3)"),
          ],
        }),
        7,
      )
      expect(action.kind === "comment" && action.body).toContain(
        [
          "- [Test (Linux, 3/3)](https://github.com/o/r/actions/runs/1/job/6) (log not read)",
          "- [Test (Windows, 2/3)](https://github.com/o/r/actions/runs/1/job/5) (cancelled)",
          "  - Not explained: `no failed test in its log`",
        ].join("\n"),
      )
      expect(action.kind === "comment" && action.body).toContain("Some jobs' logs weren't read")
    })

    it("names at most ten tests under a job", () => {
      const many = Array.from(
        { length: 12 },
        (_, index) => `FAIL  src/a.test.ts > case ${index}\nError: boom\n`,
      ).join("")
      const action = decide(run({ failed: [job(5, "Test (Linux, 3/3)", many)] }), 7)
      expect(action.kind === "comment" && action.body).toContain(
        "`src/a.test.ts > case 9`, and 2 more",
      )
    })

    it("says nothing of the register when no log was read", () => {
      expect(decide(run(), 7)).toMatchObject({
        body: expect.not.stringContaining("register"),
      })
    })
  })

  context("when a night couldn't be followed to its end", () => {
    const lost = run({
      workflow: "E2E (pinned)",
      failed: [],
      lost: "it was still going after 310 minutes of waiting for it.",
    })

    it("opens the night's issue as a failed night, saying why", () => {
      const action = decide(lost, null)
      expect(action).toMatchObject({ kind: "open", title: "Nightly E2E (pinned) is failing" })
      expect(action.kind === "open" && action.body).toContain(
        "failed.\n\nIt couldn't be followed to its end: it was still going after 310 minutes of waiting for it.",
      )
    })

    it("adds to the issue still open", () => {
      expect(decide(lost, 9)).toMatchObject({ kind: "comment", issue: 9 })
    })
  })
})
