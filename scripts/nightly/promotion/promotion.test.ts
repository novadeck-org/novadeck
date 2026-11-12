import { context, describe, expect, it } from "../../test"
import {
  candidates,
  coverage,
  explain,
  judge,
  nightlies,
  pinnedTitle,
  systemOf,
  type Coverage,
  type Job,
  type Relation,
  type Run,
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
  title: "Nightly Quality",
  ...over,
})

// E2E's run on the pinned harnesses, as Nightly Quality dispatches it.
const pinned = (over: Partial<Run> = {}): Run =>
  night({
    event: "workflow_dispatch",
    actor: "github-actions[bot]",
    title: pinnedTitle,
    ...over,
  })

const relations = new Map<string, Relation>([
  [release, "identical"],
  [later, "ahead"],
  [earlier, "behind"],
])

// Green runs whose every job succeeded on all three systems, by id.
const whole = (...ids: number[]): ReadonlyMap<number, Coverage> =>
  new Map(ids.map((id) => [id, { systems: new Set(["Linux", "Windows", "macOS"]), faults: [] }]))

const job = (name: string, labels: string, conclusion: string | null = "success"): Job => ({
  name,
  labels: [labels],
  conclusion,
})

// The jobs of a green pinned E2E run and of a green Nightly Quality, trimmed to one row a
// system, as their latest attempts list them.
const probes = "Probes (${{ matrix.setup.name }}, ${{ matrix.slice.name }})"
const e2eJobs: readonly Job[] = [
  job("Plan", "ubuntu-latest"),
  job(probes, "ubuntu-latest", "skipped"),
  job("Claude Code (1/2)", "ubuntu-latest"),
  job("Mixed", "ubuntu-latest"),
  job("Claude Code (Windows, 1/2)", "windows-latest"),
  job("Codex (Windows quirks)", "windows-latest"),
  job("Claude Code (macOS, 1/2)", "macos-latest"),
  job("Codex (macOS)", "macos-latest"),
  job("E2E", "ubuntu-latest"),
]
const qualityJobs: readonly Job[] = [
  job("Format", "ubuntu-latest"),
  job("Lint", "ubuntu-latest"),
  job("Build", "ubuntu-latest"),
  job("Test (Linux, 1/3)", "ubuntu-latest"),
  job("Test (Windows, 1/3)", "windows-latest"),
  job("Test (macOS)", "macos-latest"),
  job("Start Pinned E2E", "ubuntu-latest"),
]

const on = (system: string): string =>
  system === "Linux" ? "ubuntu-latest" : `${system.toLowerCase()}-latest`

describe("a release's promotion", () => {
  context("when Nightly Quality passed after its commit", () => {
    it("may go ahead, on the newest such run", () => {
      const newest = night({ id: 2, url: "https://github.com/o/r/actions/runs/2" })
      const verdict = judge(
        quality,
        [night({ createdAt: "2026-11-10T00:23:00Z", sha: release }), newest],
        relations,
        whole(1, 2),
      )
      expect(verdict).toEqual({ ok: true, run: newest })
    })

    it("counts a run on its very commit, and one a person dispatched", () => {
      expect(
        judge(quality, [night({ sha: release, event: "workflow_dispatch" })], relations, whole(1))
          .ok,
      ).toBe(true)
    })

    it("never counts a pull request's run of it, which only proves an edit to the workflow", () => {
      expect(judge(quality, [night({ event: "pull_request" })], relations, whole(1)).ok).toBe(false)
    })
  })

  context("when the pinned E2E run passed after its commit on all three systems", () => {
    it("may go ahead", () => {
      const run = pinned({ id: 7 })
      expect(judge(e2e, [run], relations, whole(7))).toEqual({ ok: true, run })
    })

    it("counts it by its title, whoever dispatched it, a person's run on the pinned ones too", () => {
      const run = pinned({ id: 8, actor: "someone" })
      expect(judge(e2e, [run], relations, whole(8)).ok).toBe(true)
    })
  })

  context("when the only green E2E run after its commit is not the pinned one", () => {
    it("counts no run on the latest harnesses, its night or a dispatch, nor one from before the title, whoever started it", () => {
      const runs = [
        night({ id: 1, title: "E2E on the latest harnesses" }),
        pinned({ id: 2, title: "E2E on the latest harnesses" }),
        pinned({ id: 3, title: "E2E on the latest harnesses", actor: "someone" }),
        // Before e2e.yml titled its runs, a dispatch was titled for the workflow alone.
        pinned({ id: 4, title: "E2E" }),
        night({ id: 5, title: pinnedTitle }),
      ]
      const verdict = judge(e2e, runs, relations, whole(1, 2, 3, 4, 5))
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
        whole(3),
      )
      expect(verdict.ok).toBe(true)
    })
  })

  context("when a green run's jobs don't cover every system", () => {
    it("is refused, naming the jobs that didn't succeed and the systems no test row passed on", () => {
      const run = pinned({ id: 4, url: "https://github.com/o/r/actions/runs/4" })
      const jobs = e2eJobs.map((each) =>
        each.labels[0] === "ubuntu-latest" ? each : { ...each, conclusion: "skipped" },
      )
      const verdict = judge(e2e, [run], relations, new Map([[4, coverage(e2e, jobs)]]))
      expect(verdict).toMatchObject({ ok: false, partial: { run, missing: ["Windows", "macOS"] } })
      expect(explain(e2e, "v1.2.3", release, verdict)).toContain(
        "doesn't count: `Claude Code (Windows, 1/2)` skipped, `Codex (Windows quirks)` skipped, `Claude Code (macOS, 1/2)` skipped, `Codex (macOS)` skipped; no test row passed on Windows or macOS: https://github.com/o/r/actions/runs/4.",
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
        whole(1),
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
      expect(said).toContain("promote with a reason in `skip-nightlies`")
    })
  })

  context("when every green nightly ran before its commit", () => {
    it("is refused, pointing at the newest green run as older", () => {
      const older = night({ sha: earlier, url: "https://github.com/o/r/actions/runs/5" })
      const verdict = judge(quality, [older], relations, whole(1))
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
        whole(1),
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
    expect(judge(quality, [evening], relations, whole(5))).toEqual({ ok: true, run: evening })
    expect(judge(quality, [midnight, evening], relations, whole(5, 6))).toEqual({
      ok: true,
      run: midnight,
    })
    const before = night({ id: 7, createdAt: "2026-11-14T23:59:00Z", sha: earlier })
    expect(judge(quality, [before, evening], relations, whole(5, 7))).toEqual({
      ok: true,
      run: evening,
    })
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

describe("what a green run's jobs cover", () => {
  it("is every system, when every job succeeded but the probes a pinned run skips by design", () => {
    expect(coverage(e2e, e2eJobs)).toEqual({
      systems: new Set(["Linux", "Windows", "macOS"]),
      faults: [],
    })
    expect(coverage(quality, qualityJobs).faults).toEqual([])
  })

  it("refuses a run with any other job skipped, cancelled or failed, the probes' rows by another name too", () => {
    const run = pinned({ id: 6 })
    for (const conclusion of ["skipped", "cancelled", "failure", null]) {
      const jobs = e2eJobs.map((each) =>
        each.name === "Codex (macOS)" ? { ...each, conclusion } : each,
      )
      expect(judge(e2e, [run], relations, new Map([[6, coverage(e2e, jobs)]])).ok).toBe(false)
    }
    const expanded = [...e2eJobs, job("Probes (Claude Code, 1/2)", "ubuntu-latest", "skipped")]
    expect(coverage(e2e, expanded).faults).toEqual(["`Probes (Claude Code, 1/2)` skipped"])
  })

  it.each(["Linux", "Windows", "macOS"])(
    "refuses a green run whose %s test rows were all skipped, though its plan and gate passed there",
    (system) => {
      const run = pinned({ id: 7 })
      const rows = (each: Job) =>
        each.labels[0] === on(system) && each.name !== "Plan" && each.name !== "E2E"
      const skipped = e2eJobs.map((each) =>
        rows(each) ? { ...each, conclusion: "skipped" } : each,
      )
      const verdict = judge(e2e, [run], relations, new Map([[7, coverage(e2e, skipped)]]))
      expect(verdict).toMatchObject({ ok: false, partial: { missing: [system] } })
      // Rows that never ran at all leave the system uncovered the same way.
      const gone = e2eJobs.filter((each) => !rows(each))
      expect(coverage(e2e, gone)).toMatchObject({ faults: [] })
      expect(judge(e2e, [run], relations, new Map([[7, coverage(e2e, gone)]])).ok).toBe(false)
    },
  )

  it.each(["Linux", "Windows", "macOS"])(
    "takes no check of Nightly Quality's for a %s test row",
    (system) => {
      const run = night({ id: 8 })
      const gone = qualityJobs.filter(
        (each) => !(each.name.startsWith("Test (") && each.labels[0] === on(system)),
      )
      const verdict = judge(quality, [run], relations, new Map([[8, coverage(quality, gone)]]))
      expect(verdict).toMatchObject({ ok: false, partial: { missing: [system], faults: [] } })
    },
  )

  it("covers no system with a job whose runner it can't read, and refuses one that didn't succeed", () => {
    const unread = [job("Test (Linux, 1/3)", "self-hosted"), job("Test (macOS)", "macos-latest")]
    expect(coverage(quality, unread).systems).toEqual(new Set(["macOS"]))
    const broken = [...qualityJobs, { name: "Odd", labels: [], conclusion: "failure" }]
    expect(coverage(quality, broken).faults).toEqual(["`Odd` failure"])
  })

  it("is nothing for a green run whose jobs weren't read", () => {
    expect(judge(quality, [night({ id: 9 })], relations).ok).toBe(false)
  })

  it("reads a pinned runner image as its system", () => {
    expect(systemOf(["ubuntu-24.04"])).toBe("Linux")
    expect(systemOf(["macos-15"])).toBe("macOS")
    expect(systemOf(["windows-2025"])).toBe("Windows")
  })
})
