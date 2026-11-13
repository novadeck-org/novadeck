import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach } from "vitest"

import { context, describe, expect, it } from "../test"
import { parseRegister } from "./match"
import {
  attemptOf,
  budget,
  budgetAction,
  budgetTitle,
  cell,
  commentMarker,
  keysNamed,
  overBudget,
  packagesChanged,
  prComment,
  pullRequestsOf,
  recordSummary,
  runOf,
  runRecord,
  tally,
  tallyReport,
  within,
  type Run,
  type RunRecord,
} from "./retries"
import type { Retried } from "./retry/record"

const register = parseRegister(JSON.parse(readFileSync("scripts/flakes/register.json", "utf8")))
const zw = String.fromCharCode(0x200b)
const fixed = register.flakes.find((flake) => flake.id === "ui-companions-plan-reopen-place")!
// A failure of the fixed flake's test that its signature matches, as it fails when it's back.
const backError = "AssertionError: expected 3 to be 200"

const retried = (test: string, more: Partial<Retried> = {}): Retried => ({
  test,
  file: test.split(" > ")[0]!,
  package: "@novadeck/sandbox",
  project: "",
  attempts: 2,
  error: "AssertionError: expected [] to have a length of 1 but got +0",
  ...more,
})
const line = (entry: Retried): string => `${JSON.stringify(entry)}\n`

const reap = "src/reap.test.ts > reap on macOS > ends one found through its parent"
const pty = "src/pty/native.test.ts > installed native PTY dependency > keeps a session"

/** A run as the Actions API describes it. */
const apiRun = (id: number, at: string, more: Record<string, unknown> = {}) => ({
  id,
  name: "Quality",
  run_attempt: 1,
  html_url: `https://github.com/o/r/actions/runs/${id}`,
  head_sha: "abc",
  event: "pull_request",
  head_branch: "task/x",
  pull_requests: [{ number: 7 }],
  updated_at: at,
  ...more,
})
const run = (id: number, at: string): Run => runOf(apiRun(id, at))
const record = (
  id: number,
  at: string,
  entries: readonly Retried[],
  artifact = "retried-macOS-1",
) => runRecord(run(id, at), new Map([[artifact, entries.map(line)]]))

describe("a run's retries", () => {
  it("are every record file of every artifact, each named by its artifact and attempt", () => {
    const found = runRecord(
      run(1, "2026-11-10T10:00:00Z"),
      new Map([
        ["retried-macOS-1", [line(retried(reap)), ""]],
        ["retried-Linux-2-2", [line(retried(pty, { package: "@novadeck/terminal" }))]],
      ]),
    )
    expect(found.retried.map((entry) => [entry.artifact, entry.attempt, entry.test])).toEqual([
      ["retried-Linux-2-2", 2, pty],
      ["retried-macOS-1", 1, reap],
    ])
  })

  it("fail to read from a broken record, rather than lose what it held", () => {
    expect(() =>
      runRecord(run(1, "2026-11-10T10:00:00Z"), new Map([["retried-macOS-1", ["{ x\n"]]])),
    ).toThrow(/isn't JSON/)
  })

  it("know an artifact's attempt by its name, and refuse one that names none", () => {
    expect(attemptOf("retried-e2e-Claude Code-Linux-2-3")).toBe(3)
    expect(() => attemptOf("retried-macOS")).toThrow(/names no attempt/)
  })

  it("read a run from the Actions API, and refuse what isn't one", () => {
    expect(run(5, "2026-11-10T10:00:00Z")).toMatchObject({
      workflow: "Quality",
      run: 5,
      pullRequests: [7],
    })
    expect(() => runOf({ name: "Quality" })).toThrow(/Not a workflow run/)
  })

  it("name a run by its workflow, where Retried Tests adds it, not by the run's own title", () => {
    // Since #881 an E2E run's own `name` is its title: its pull request's, or its harnesses'.
    const titled = apiRun(6, "2026-11-12T10:00:00Z", { name: "feat(ui): a pane of its own" })
    expect(runOf({ ...titled, workflow_name: "E2E" }).workflow).toBe("E2E")
    expect(runOf(titled).workflow).toBe("feat(ui): a pane of its own")
  })

  context("in the job's summary", () => {
    it("names each retried test, its job, its first failure and what the register says", () => {
      const summary = recordSummary(
        record(1, "2026-11-10T10:00:00Z", [
          retried(reap),
          retried(fixed.test!, { error: backError }),
        ]),
        register,
      )
      expect(summary).toContain("2 test(s) passed only on a retry.")
      expect(summary).toContain(`| ${reap} | @${zw}novadeck/sandbox | retried-macOS-1 | 2 |`)
      expect(summary).toContain("not registered")
      expect(summary).toContain(`**${fixed.id}, registered as fixed: back**`)
    })
  })

  it("are shown without HTML, column breaks or mentions, as a pull request's tests wrote them", () => {
    expect(cell("a | <b> @someone\nnext")).toBe(`a \\| &lt;b> @${zw}someone next`)
    expect(cell("x".repeat(300))).toHaveLength(200)
  })
})

describe("the count of a test's retries", () => {
  const records: RunRecord[] = [
    record(1, "2026-11-04T10:00:00Z", [retried(reap)]),
    runRecord(
      run(2, "2026-11-08T10:00:00Z"),
      new Map([
        ["retried-macOS-1", [line(retried(reap, { attempts: 3 })), line(retried(pty))]],
        // The same run's rerun retried it again: the run counts once, its retries add up.
        ["retried-macOS-2", [line(retried(reap))]],
      ]),
    ),
    // A run whose retry came only in its rerun's attempt.
    record(3, "2026-11-09T10:00:00Z", [retried(reap)], "retried-macOS-2"),
  ]

  it("counts the distinct runs it needed one in, reruns' too, and every extra run they took", () => {
    const [first, second] = tally(records)
    expect(first).toMatchObject({ test: reap, runs: 3, retries: 5, last: "2026-11-09T10:00:00Z" })
    expect(first!.links).toHaveLength(3)
    expect(second).toMatchObject({ test: pty, runs: 1, retries: 1 })
  })

  it("keeps a test apart from one of the same name in another package", () => {
    const other = record(4, "2026-11-09T10:00:00Z", [
      retried(reap, { package: "@novadeck/runner" }),
    ])
    expect(tally([...records, other]).map((entry) => [entry.package, entry.runs])).toEqual([
      ["@novadeck/sandbox", 3],
      ["@novadeck/runner", 1],
      ["@novadeck/sandbox", 1],
    ])
  })

  it("takes only the runs that finished in the window", () => {
    const since = new Date("2026-11-05T00:00:00Z")
    expect(tally(within(records, since))[0]).toMatchObject({ test: reap, runs: 2 })
  })

  context("against the budget", () => {
    it(`puts a test retried in ${budget.runs} runs over it, and one in fewer within it`, () => {
      const [often, once] = tally(records)
      expect(overBudget(often!, register)).toBe(`retried in 3 runs in ${budget.days} days`)
      expect(overBudget(once!, register)).toBeUndefined()
    })

    it("puts a flake registered as fixed over it at its first retry", () => {
      const [back] = tally([
        record(9, "2026-11-09T10:00:00Z", [retried(fixed.test!, { error: backError })]),
      ])
      expect(overBudget(back!, register)).toBe("registered as fixed, and retried again")
    })

    it("takes a registered test failing another way for no flake, as Triage would", () => {
      const [other] = tally([
        record(9, "2026-11-09T10:00:00Z", [retried(fixed.test!, { error: "TimeoutError: 5s" })]),
      ])
      expect(overBudget(other!, register)).toBeUndefined()
    })

    // An entry for a whole folder, as a process left behind can end any end to end test, is
    // that flake only where the failure is its own: on 2026-11-11 it claimed two tests of the
    // folder that failed other ways, and put them over the budget as fixed flakes back.
    context("when an entry names a whole folder", () => {
      const left = register.flakes.find(
        (flake) => flake.id === "e2e-claude-macos-mixed-outlived-deck",
      )!
      const image =
        "src/e2e/images.e2e.ts > Codex > gives its agent a prompt with two images among its words"
      const runner = { package: "@novadeck/runner" }

      it("isn't a test of it that failed another way", () => {
        const failed = record(9, "2026-11-11T05:30:38Z", [
          retried(image, { ...runner, error: "DomainError: The agent did not take the image." }),
        ])
        const [entry] = tally([failed])
        expect(overBudget(entry!, register)).toBeUndefined()
        expect(
          tallyReport([entry!], register, { since: new Date(0), until: new Date(1), runs: 1 })
            .tests[0]!.flake,
        ).toBeNull()
        expect(recordSummary(failed, register)).toContain("not registered")
      })

      it("is a test of it that failed its way", () => {
        const failed = record(9, "2026-11-11T05:30:38Z", [
          retried(image, {
            ...runner,
            error: "Error: a process outlived the deck in the sandbox: claude (4242)",
          }),
        ])
        const [entry] = tally([failed])
        expect(new RegExp(left.signature).test(entry!.failures[0]!)).toBe(true)
        expect(overBudget(entry!, register)).toBe("registered as fixed, and retried again")
        expect(recordSummary(failed, register)).toContain(
          `**${left.id}, registered as fixed: back**`,
        )
      })
    })
  })

  it("is published for the scoreboard in its documented shape", () => {
    const since = new Date("2026-11-03T00:00:00Z")
    const until = new Date("2026-11-10T00:00:00Z")
    const report = tallyReport(tally(records), register, { since, until, runs: 3 })
    expect(report).toEqual({
      since: "2026-11-03T00:00:00.000Z",
      until: "2026-11-10T00:00:00.000Z",
      days: 7,
      budget: { runs: 3, days: 7 },
      runs: 3,
      tests: [
        {
          test: reap,
          package: "@novadeck/sandbox",
          runs: 3,
          retries: 5,
          last: "2026-11-09T10:00:00Z",
          over: "retried in 3 runs in 7 days",
          flake: null,
        },
        {
          test: pty,
          package: "@novadeck/sandbox",
          runs: 1,
          retries: 1,
          last: "2026-11-08T10:00:00Z",
          over: null,
          flake: null,
        },
      ],
    })
  })
})

describe("the budget issue", () => {
  const since = new Date("2026-11-03T00:00:00Z")
  const where = { url: "https://github.com/o/r/actions/runs/99", since }
  const often = [1, 2, 3].map((id) => record(id, "2026-11-08T10:00:00Z", [retried(reap)]))

  it("opens when a test goes over, naming it and why", () => {
    const action = budgetAction(tally(often), register, null, where)
    expect(action).toMatchObject({ kind: "open", title: budgetTitle })
    if (action.kind !== "open") return
    expect(action.body).toContain(reap)
    expect(action.body).toContain("retried in 3 runs in 7 days")
    expect(keysNamed(action.body)).toEqual([`@novadeck/sandbox ${reap}`])
    // The count can't tell a test fixed since from one still flaking, and says so.
    expect(action.body).toContain("even once a fix has landed")
  })

  it("is edited each day while one is over, with a comment only when a test joins it", () => {
    const opened = budgetAction(tally(often), register, null, where)
    if (opened.kind !== "open") throw new Error("expected an issue to open")
    const same = budgetAction(tally(often), register, { number: 5, body: opened.body }, where)
    expect(same).toMatchObject({ kind: "edit", issue: 5 })
    expect(same).not.toHaveProperty("comment")
    const more = [
      ...often,
      record(4, "2026-11-08T10:00:00Z", [retried(fixed.test!, { error: backError })]),
    ]
    const joined = budgetAction(tally(more), register, { number: 5, body: opened.body }, where)
    expect(joined).toMatchObject({ kind: "edit", issue: 5 })
    expect(joined.kind === "edit" && joined.comment).toContain(fixed.test!.slice(0, 40))
  })

  it("closes once every retried test is within the budget, and does nothing while none was over", () => {
    const calm = tally([record(1, "2026-11-08T10:00:00Z", [retried(pty)])])
    expect(budgetAction(calm, register, { number: 5, body: "" }, where)).toMatchObject({
      kind: "close",
      issue: 5,
    })
    expect(budgetAction(calm, register, null, where)).toEqual({ kind: "none" })
  })
})

describe("the pull request a run is for", () => {
  const head = "0123456789abcdef0123456789abcdef01234567"
  const group = (branch: string, more: Record<string, unknown> = {}) =>
    runOf(
      apiRun(1, "2026-11-11T10:00:00Z", {
        event: "merge_group",
        head_branch: branch,
        pull_requests: [],
        ...more,
      }),
    )

  it("is the one a pull request's run names", () => {
    expect(pullRequestsOf(run(1, "2026-11-11T10:00:00Z"))).toEqual([7])
  })

  it("is read from a merge group's branch, whose run names none", () => {
    expect(pullRequestsOf(group(`gh-readonly-queue/main/pr-847-${head}`))).toEqual([847])
    // A base branch may hold slashes.
    expect(pullRequestsOf(group(`gh-readonly-queue/release/v2/pr-12-${head}`))).toEqual([12])
  })

  it("is none for a branch GitHub didn't name for a group, or a run that isn't a group's", () => {
    expect(pullRequestsOf(group("gh-readonly-queue/main/pr-847"))).toEqual([])
    expect(pullRequestsOf(group(`gh-readonly-queue/main/pr-0-${head}`))).toEqual([])
    expect(pullRequestsOf(group(`gh-readonly-queue/pr-847-${head}`))).toEqual([])
    expect(pullRequestsOf(group(`task/gh-readonly-queue/main/pr-847-${head}`))).toEqual([])
    // A pull request's own branch named like a group's names nothing on a push.
    expect(
      pullRequestsOf(group(`gh-readonly-queue/main/pr-847-${head}`, { event: "push" })),
    ).toEqual([])
  })
})

describe("the pull request's comment", () => {
  const changed = new Set(["@novadeck/terminal"])
  const first = record(1, "2026-11-10T10:00:00Z", [
    retried(reap),
    retried(pty, { package: "@novadeck/terminal" }),
  ])

  it("lists the tests in packages the pull request changes first, and folds the rest", () => {
    const body = prComment(undefined, first, changed)!
    expect(body.startsWith(commentMarker)).toBe(true)
    expect(body).toContain("**1 in packages this pull request changes:**")
    expect(body.indexOf(pty)).toBeLessThan(body.indexOf("<details>"))
    expect(body.indexOf(reap)).toBeGreaterThan(body.indexOf("<details>"))
  })

  it("is updated with each run's retries, a run counted once however many attempts it took", () => {
    const body = prComment(undefined, first, changed)!
    const again = prComment(body, first, changed)!
    const next = prComment(again, record(2, "2026-11-10T11:00:00Z", [retried(reap)]), changed)!
    expect(next).toContain(
      "[1](https://github.com/o/r/actions/runs/1) [2](https://github.com/o/r/actions/runs/2)",
    )
    expect(next.match(new RegExp(reap, "g"))).toHaveLength(1)
    // What an earlier run retried stays, though this one retried none of it.
    expect(next).toContain(pty)
  })

  it("marks a merge group's run, which ran the change on top of the queue", () => {
    const grouped = runRecord(
      runOf(
        apiRun(3, "2026-11-10T12:00:00Z", {
          event: "merge_group",
          head_branch: `gh-readonly-queue/main/pr-7-${"a".repeat(40)}`,
          pull_requests: [],
        }),
      ),
      new Map([["retried-macOS-1", [line(retried(reap))]]]),
    )
    const body = prComment(prComment(undefined, first, changed), grouped, changed)!
    expect(body).toContain(
      "[1](https://github.com/o/r/actions/runs/1) [3](https://github.com/o/r/actions/runs/3) (queue)",
    )
  })

  it("isn't written while none of the pull request's runs retried a test", () => {
    expect(prComment(undefined, record(1, "2026-11-10T10:00:00Z", []), changed)).toBeUndefined()
  })

  it("knows a changed file's package by its folder", () => {
    const names = new Map([
      ["libraries/terminal", "@novadeck/terminal"],
      ["backend/runner", "@novadeck/runner"],
    ])
    expect([
      ...packagesChanged(["libraries/terminal/src/pty.ts", "docs/x.md", "README.md"], names),
    ]).toEqual(["@novadeck/terminal"])
  })
})

describe("an error recorded with its terminal colours", () => {
  // As #855's comment showed it: Vitest colours an assertion's message even on CI, and the
  // record kept the colours until the reporter took them out.
  const esc = String.fromCharCode(0x1b)
  const coloured = `${esc}[2mexpect(${esc}[22m${esc}[31melement${esc}[39m${esc}[2m).toBeVisible()${esc}[22m`
  const plain = "expect(element).toBeVisible()"
  const old = record(1, "2026-11-10T10:00:00Z", [retried(reap, { error: coloured })])

  it("is read without them from a record written before", () => {
    expect(old.retried[0]!.error).toBe(plain)
    expect(tally([old])[0]!.errors).toEqual([plain])
    expect(recordSummary(old, register)).toContain(`| ${plain} |`)
  })

  it("is shown without them in the pull request's comment", () => {
    const body = prComment(undefined, old, new Set())!
    expect(body).toContain(`| ${plain} |`)
    expect(body).not.toContain(esc)
  })

  it("loses them from a comment written before, whose state still holds them", () => {
    const state = [
      { test: reap, package: "@novadeck/sandbox", error: coloured, runs: [{ run: 1, url: "u" }] },
    ]
    const before = `${commentMarker}\n<!-- state ${Buffer.from(JSON.stringify(state)).toString("base64")} -->\n`
    const body = prComment(before, record(2, "2026-11-10T11:00:00Z", [retried(reap)]), new Set())!
    expect(body).toContain(`| ${plain} |`)
    expect(
      body
        .split("\n")
        .filter((row) => row.startsWith("|"))
        .join("\n"),
    ).not.toContain(esc)
  })
})

describe("Known Flakes' comment and tally commands", () => {
  const scratch: string[] = []
  afterEach(() => {
    for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true })
  })
  const folder = (): string => {
    const made = mkdtempSync(join(tmpdir(), "known-flakes-"))
    scratch.push(made)
    return made
  }
  const cli = (args: readonly string[], env: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, ["scripts/flakes/retries-main.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: "", GITHUB_OUTPUT: "", ...env },
    })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  }
  /** A run's folder as the workflow downloads it: run.json, and an artifact folder each. */
  const runFolder = (
    root: string,
    id: number,
    artifacts: Record<string, readonly Retried[]>,
  ): string => {
    const at = join(root, String(id))
    mkdirSync(at, { recursive: true })
    writeFileSync(join(at, "run.json"), JSON.stringify(apiRun(id, new Date().toISOString())))
    for (const [name, entries] of Object.entries(artifacts)) {
      // An E2E job's artifact holds the record beside its traces.
      mkdirSync(join(at, name, "test-results", "retried"), { recursive: true })
      mkdirSync(join(at, name, "e2e-traces"), { recursive: true })
      writeFileSync(join(at, name, "e2e-traces", "trace.txt"), "a trace")
      writeFileSync(
        join(at, name, "test-results", "retried", "x-1.jsonl"),
        entries.map(line).join(""),
      )
    }
    return at
  }

  it("count a retry that came only in a run's rerun, and open the issue for a test over budget", () => {
    const root = folder()
    const runs = join(root, "runs")
    runFolder(runs, 1, { "retried-macOS-1": [retried(reap)] })
    // Its first attempt retried nothing; the rerun of its failed job did.
    runFolder(runs, 2, { "retried-macOS-2": [retried(reap)] })
    runFolder(runs, 3, {
      "retried-e2e-Codex-Linux-1": [retried(reap)],
      "retried-e2e-Codex-Linux-2": [retried(reap)],
    })
    writeFileSync(join(root, "open.json"), "")
    const output = join(root, "output")
    const result = cli(["tally", runs, "7", root, join(root, "open.json")], {
      GITHUB_OUTPUT: output,
      RUN_URL: "https://github.com/o/r/actions/runs/99",
    })
    expect(result.status, result.output).toBe(0)
    const report = JSON.parse(readFileSync(join(root, "tally.json"), "utf8"))
    expect(report.tests).toEqual([expect.objectContaining({ test: reap, runs: 3, retries: 4 })])
    expect(JSON.parse(readFileSync(join(root, "issue.json"), "utf8"))).toMatchObject({
      kind: "open",
      title: budgetTitle,
    })
    expect(readFileSync(output, "utf8")).toBe("over=1\n")
  })

  it("write a pull request's comment, marking a test in a package it changed", () => {
    const root = folder()
    const at = runFolder(join(root, "runs"), 1, {
      "retried-Linux-1-1": [retried(pty, { package: "@novadeck/terminal" }), retried(reap)],
    })
    writeFileSync(join(root, "files.txt"), "libraries/terminal/src/pty/native.ts\n")
    writeFileSync(join(root, "previous.md"), "")
    const out = join(root, "comment.md")
    const result = cli([
      "comment",
      join(at, "run.json"),
      at,
      join(root, "files.txt"),
      join(root, "previous.md"),
      out,
    ])
    expect(result.status, result.output).toBe(0)
    const body = readFileSync(out, "utf8")
    expect(body).toContain("**1 in packages this pull request changes:**")
    expect(body.indexOf(pty)).toBeLessThan(body.indexOf("<details>"))
  })

  it("write no comment for a run that retried nothing", () => {
    const root = folder()
    const at = runFolder(join(root, "runs"), 1, {})
    const out = join(root, "comment.md")
    const result = cli([
      "comment",
      join(at, "run.json"),
      at,
      join(root, "none"),
      join(root, "none"),
      out,
    ])
    expect(result.status, result.output).toBe(0)
    expect(() => readFileSync(out)).toThrow()
  })

  it("name a merge group's pull request from its branch, and none for a run that is for none", () => {
    const root = folder()
    const write = (name: string, more: Record<string, unknown>) => {
      const path = join(root, name)
      writeFileSync(path, JSON.stringify(apiRun(1, new Date().toISOString(), more)))
      return path
    }
    const group = write("group.json", {
      event: "merge_group",
      head_branch: `gh-readonly-queue/main/pr-847-${"b".repeat(40)}`,
      pull_requests: [],
    })
    expect(cli(["pulls", group])).toEqual({ status: 0, output: "847\n" })
    expect(cli(["pulls", write("pr.json", {})])).toEqual({ status: 0, output: "7\n" })
    expect(cli(["pulls", write("push.json", { event: "push", pull_requests: [] })])).toEqual({
      status: 0,
      output: "",
    })
  })

  it("fail on a record it can't read, rather than count without it", () => {
    const root = folder()
    const at = runFolder(join(root, "runs"), 1, {})
    mkdirSync(join(at, "retried-macOS-1"))
    writeFileSync(join(at, "retried-macOS-1", "s-2.jsonl"), "{ broken\n")
    const result = cli(["tally", join(root, "runs"), "7", root, join(root, "none")])
    expect(result.status).toBe(1)
    expect(result.output).toContain("isn't JSON")
  })
})
