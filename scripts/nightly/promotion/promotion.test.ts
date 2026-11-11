import { context, describe, expect, it } from "../../test"
import {
  candidates,
  explain,
  judge,
  nightlies,
  passedOn,
  systemOf,
  type Relation,
  type Run,
  type System,
} from "./promotion"

const release = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
const later = "bbbbbbbbe5f60718293a4b5c6d7e8f9012345678"
const earlier = "cccccccce5f60718293a4b5c6d7e8f9012345678"

const [quality, e2e] = nightlies as [(typeof nightlies)[0], (typeof nightlies)[0]]

const night = (over: Partial<Run> = {}): Run => ({
  id: 1,
  url: "https://github.com/o/r/actions/runs/1",
  sha: later,
  event: "schedule",
  actor: "someone",
  conclusion: "success",
  createdAt: "2026-11-11T00:23:00Z",
  ...over,
})

// E2E's run on the pinned harnesses, as Nightly Quality dispatches it.
const pinned = (over: Partial<Run> = {}): Run =>
  night({ event: "workflow_dispatch", actor: "github-actions[bot]", ...over })

const relations = new Map<string, Relation>([
  [release, "identical"],
  [later, "ahead"],
  [earlier, "behind"],
])

const everywhere: ReadonlySet<System> = new Set(["Linux", "Windows", "macOS"])

describe("a release's promotion", () => {
  context("when Nightly Quality passed after its commit", () => {
    it("may go ahead, on the newest such run", () => {
      const newest = night({ id: 2, url: "https://github.com/o/r/actions/runs/2" })
      const verdict = judge(
        quality,
        [night({ createdAt: "2026-11-10T00:23:00Z", sha: release }), newest],
        relations,
      )
      expect(verdict).toEqual({ ok: true, run: newest })
    })

    it("counts a run on its very commit, and one a person dispatched", () => {
      expect(
        judge(quality, [night({ sha: release, event: "workflow_dispatch" })], relations).ok,
      ).toBe(true)
    })

    it("never counts a pull request's run of it, which only proves an edit to the workflow", () => {
      expect(judge(quality, [night({ event: "pull_request" })], relations).ok).toBe(false)
    })
  })

  context("when the pinned E2E run passed after its commit on all three systems", () => {
    it("may go ahead", () => {
      const run = pinned({ id: 7 })
      expect(judge(e2e, [run], relations, new Map([[7, everywhere]]))).toEqual({ ok: true, run })
    })
  })

  context("when the only green E2E run after its commit is not the pinned one", () => {
    it("counts neither E2E's own night, on the latest harnesses, nor a person's dispatch", () => {
      const runs = [night({ id: 1 }), night({ id: 2, event: "workflow_dispatch" })]
      const systems = new Map([
        [1, everywhere],
        [2, everywhere],
      ])
      const verdict = judge(e2e, runs, relations, systems)
      expect(verdict.ok).toBe(false)
      expect(explain(e2e, "v1.2.3", release, verdict)).toContain(
        "It has no green run on main yet. To unblock, start a night, which starts this run when its tests are done: `gh workflow run quality-nightly.yml --ref main`",
      )
    })

    it("counts a failed E2E night on the latest harnesses against nothing either", () => {
      const verdict = judge(
        e2e,
        [night({ conclusion: "failure" }), pinned({ id: 3 })],
        relations,
        new Map([[3, everywhere]]),
      )
      expect(verdict.ok).toBe(true)
    })
  })

  context("when the pinned E2E run passed but skipped a system", () => {
    it("is refused, naming the system", () => {
      const run = pinned({ id: 4, url: "https://github.com/o/r/actions/runs/4" })
      const verdict = judge(e2e, [run], relations, new Map([[4, new Set<System>(["Linux"])]]))
      expect(verdict).toMatchObject({ ok: false, partial: { run, missing: ["Windows", "macOS"] } })
      expect(explain(e2e, "v1.2.3", release, verdict)).toContain(
        "has no passed job on Windows or macOS: https://github.com/o/r/actions/runs/4.",
      )
    })
  })

  context("when the nightlies after its commit failed", () => {
    it("is refused, naming the newest failed run and how to rerun it", () => {
      const failed = night({
        id: 9,
        conclusion: "failure",
        url: "https://github.com/o/r/actions/runs/9",
      })
      const verdict = judge(
        quality,
        [failed, night({ sha: earlier, createdAt: "2026-11-09T00:23:00Z" })],
        relations,
      )
      expect(verdict).toMatchObject({ ok: false, failed })
      const said = explain(quality, "v1.2.3", release, verdict)
      expect(said).toContain(
        "v1.2.3 (a1b2c3d4) has no green Nightly Quality at or after its commit",
      )
      expect(said).toContain(
        "ended `failure` on bbbbbbbb: https://github.com/o/r/actions/runs/9. Fix what failed, or if it was a flake rerun its failed jobs: `gh run rerun 9 --failed`.",
      )
      expect(said).toContain(
        "To unblock, start a night: `gh workflow run quality-nightly.yml --ref main`, wait for it to pass, then promote again.",
      )
    })
  })

  context("when every green nightly ran before its commit", () => {
    it("is refused, pointing at the newest green run as older", () => {
      const older = night({ sha: earlier, url: "https://github.com/o/r/actions/runs/5" })
      const verdict = judge(quality, [older], relations)
      expect(verdict).toMatchObject({ ok: false, older })
      expect(explain(quality, "v1.2.3", release, verdict)).toContain(
        "Its newest green run is on cccccccc, older than the release: https://github.com/o/r/actions/runs/5.",
      )
    })

    it("counts a run on a commit apart from main's history, or one not compared, as not after it", () => {
      const verdict = judge(
        quality,
        [night({ sha: "dddd" }), night({ sha: "eeee" })],
        new Map([["dddd", "diverged" as Relation]]),
      )
      expect(verdict.ok).toBe(false)
    })
  })

  it("judges a night by its commit, not the date it started: the evening before or after midnight", () => {
    // GitHub starts the nightly's cron hours late: one night on the evening before the
    // release, on its commit, and the next just after midnight, on a later one, both count;
    // the newest, after midnight, is the one named.
    const evening = night({ id: 5, createdAt: "2026-11-12T17:41:00Z", sha: release })
    const midnight = night({ id: 6, createdAt: "2026-11-14T00:52:00Z", sha: later })
    expect(judge(quality, [evening], relations)).toEqual({ ok: true, run: evening })
    expect(judge(quality, [midnight, evening], relations)).toEqual({ ok: true, run: midnight })
    const before = night({ id: 7, createdAt: "2026-11-14T23:59:00Z", sha: earlier })
    expect(judge(quality, [before, evening], relations)).toEqual({ ok: true, run: evening })
  })

  it("compares only the newest runs that count with the release", () => {
    const runs = Array.from({ length: 14 }, (_, day) =>
      night({ createdAt: `2026-11-${String(day + 10).padStart(2, "0")}T00:23:00Z` }),
    )
    const chosen = candidates(quality, [...runs, night({ event: "pull_request" })])
    expect(chosen).toHaveLength(10)
    expect(chosen[0]!.createdAt).toBe("2026-11-23T00:23:00Z")
    expect(chosen.every((each) => each.event === "schedule")).toBe(true)
  })
})

describe("the systems a run passed on", () => {
  it("are those of its jobs that succeeded, by their runners' labels", () => {
    expect(
      passedOn([
        { labels: ["ubuntu-latest"], conclusion: "success" },
        { labels: ["windows-latest"], conclusion: "failure" },
        { labels: ["macos-latest"], conclusion: "success" },
        { labels: [], conclusion: "success" },
      ]),
    ).toEqual(new Set(["Linux", "macOS"]))
  })

  it("reads a pinned runner image as its system", () => {
    expect(systemOf(["ubuntu-24.04"])).toBe("Linux")
    expect(systemOf(["macos-15"])).toBe("macOS")
    expect(systemOf(["windows-2025"])).toBe("Windows")
  })
})
