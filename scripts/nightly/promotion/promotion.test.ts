import { context, describe, expect, it } from "../../test"
import { candidates, explain, judge, nightlies, type Relation, type Run } from "./promotion"

const release = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
const later = "bbbbbbbbe5f60718293a4b5c6d7e8f9012345678"
const earlier = "cccccccce5f60718293a4b5c6d7e8f9012345678"

const run = (over: Partial<Run> = {}): Run => ({
  url: "https://github.com/o/r/actions/runs/1",
  sha: later,
  event: "schedule",
  conclusion: "success",
  createdAt: "2026-11-11T01:23:00Z",
  ...over,
})

const relations = new Map<string, Relation>([
  [release, "identical"],
  [later, "ahead"],
  [earlier, "behind"],
])

const quality = nightlies[0]!

describe("a release's promotion", () => {
  context("when a full nightly passed after its commit", () => {
    it("may go ahead, on the newest such run", () => {
      const newest = run({ url: "https://github.com/o/r/actions/runs/2" })
      const verdict = judge(
        [run({ createdAt: "2026-11-10T01:23:00Z", sha: release }), newest],
        relations,
      )
      expect(verdict).toEqual({ ok: true, run: newest })
    })

    it("counts a run on its very commit, and a dispatched one", () => {
      expect(judge([run({ sha: release, event: "workflow_dispatch" })], relations).ok).toBe(true)
    })
  })

  context("when the nightlies after its commit failed", () => {
    it("is refused, naming the newest failed run and saying to fix or rerun it", () => {
      const failed = run({ conclusion: "failure", url: "https://github.com/o/r/actions/runs/9" })
      const verdict = judge(
        [failed, run({ sha: earlier, createdAt: "2026-11-09T01:23:00Z" })],
        relations,
      )
      expect(verdict).toMatchObject({ ok: false, failed })
      const said = explain(quality, "v1.2.3", release, verdict)
      expect(said).toContain(
        "v1.2.3 (a1b2c3d4) has no green Nightly Quality at or after its commit",
      )
      expect(said).toContain(
        "ended `failure` on bbbbbbbb: https://github.com/o/r/actions/runs/9. Fix what failed, or rerun it",
      )
      expect(said).toContain(
        "To unblock: `gh workflow run quality-nightly.yml --ref main`, wait for it to pass, then promote again.",
      )
    })
  })

  context("when every green nightly ran before its commit", () => {
    it("is refused, pointing at the newest green run as older", () => {
      const older = run({ sha: earlier, url: "https://github.com/o/r/actions/runs/5" })
      const verdict = judge([older], relations)
      expect(verdict).toEqual({ ok: false, failed: undefined, older })
      expect(explain(quality, "v1.2.3", release, verdict)).toContain(
        "Its newest green run is on cccccccc, older than the release: https://github.com/o/r/actions/runs/5.",
      )
    })

    it("counts a run on a commit apart from main's history, or one not compared, as not after it", () => {
      const verdict = judge(
        [run({ sha: "dddd" }), run({ sha: "eeee" })],
        new Map([["dddd", "diverged" as Relation]]),
      )
      expect(verdict.ok).toBe(false)
    })
  })

  context("when the nightly never ran", () => {
    it("is refused, saying so and how to run it", () => {
      const said = explain(nightlies[1]!, "v1.2.3", release, judge([], relations))
      expect(said).toContain("It has no green full run on main.")
      expect(said).toContain("`gh workflow run e2e.yml --ref main`")
    })
  })

  it("never counts a pull request's run, which runs only what its change needs", () => {
    expect(judge([run({ event: "pull_request" })], relations).ok).toBe(false)
  })

  it("compares only the newest full runs with the release", () => {
    const runs = Array.from({ length: 14 }, (_, day) =>
      run({ createdAt: `2026-11-${String(day + 10).padStart(2, "0")}T01:23:00Z` }),
    )
    const chosen = candidates([...runs, run({ event: "pull_request" })])
    expect(chosen).toHaveLength(10)
    expect(chosen[0]!.createdAt).toBe("2026-11-23T01:23:00Z")
    expect(chosen.every((each) => each.event === "schedule")).toBe(true)
  })

  it("requires all of Quality's checks and the whole E2E suite", () => {
    expect(nightlies.map((nightly) => nightly.file)).toEqual(["quality-nightly.yml", "e2e.yml"])
  })
})
