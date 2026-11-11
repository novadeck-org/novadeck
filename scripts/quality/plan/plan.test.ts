import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { plan as graphPlan } from "../../ci/plan/plan.ts"
import { runGate } from "../../e2e/plan/gate.ts"
import { context, describe, expect, it } from "../../test"
import { type Package, workspacePackages } from "../../workspace/platform.ts"
import { changeCommit } from "./main.ts"
import {
  type Facts,
  filters,
  invocations,
  plan,
  declarationDiffers,
  proofChanges,
  proofRows,
  proves,
  systemPackages,
  systemMacos,
  systemWindows,
  testedFolders,
  turboTestArgs,
  wholeMacos,
  wholeWindows,
} from "./plan.ts"

const root = join(import.meta.dirname, "..", "..", "..")

// A workspace in small: what each package declares, a name and a folder.
const declared = (folder: string, platform?: unknown): Package => ({
  folder,
  manifest: {
    name: `@novadeck/${folder.split("/")[1]}`,
    ...(platform === undefined ? {} : { novadeck: { platform } }),
  },
})
const packages = [
  declared("apps/desktop", "system"),
  declared("backend/runner", "system"),
  declared("contract/protocol", "neutral"),
  declared("frontend/ui", "neutral"),
  declared("frontend/specs", "neutral"),
  declared("libraries/terminal", "system"),
  // Declares nothing, or nothing it knows: as a package added in a hurry might.
  declared("libraries/clipboard"),
  declared("libraries/fonts", "neutal"),
]
const systemFolders = systemPackages(packages).map(({ folder }) => folder)
const all = { linux: "all", windows: "all", macos: "all" } as const
// What scripts/ci/plan says a change's systems test: the repository's own tests (`//`) and the
// affected packages on Linux, the affected `system` ones on Windows and macOS.
const narrowed = (system: readonly string[]): Facts => ({
  tests: { linux: ["//", ...system, "@novadeck/ui"], windows: system, macos: system },
})

describe("Quality's systems", () => {
  context("when the plan can't narrow the change, or follows none", () => {
    // `all` is the plan's answer where it couldn't read a fact, the declarations among them.
    it("runs every test on Windows, in three parts, and on macOS, as before", () => {
      expect(plan({ tests: all }, packages)).toEqual({
        windows: true,
        macos: true,
        held: false,
        windowsRows: wholeWindows,
        windowsPackages: [],
        macosRows: wholeMacos,
        packages: [],
      })
    })

    it("plans that from the graph's plan for a run that isn't a change's", () => {
      for (const event of ["schedule", "workflow_dispatch", "push"]) {
        const { tests } = graphPlan(
          {
            event,
            packages: undefined,
            scopes: undefined,
            affected: undefined,
            files: undefined,
            suite: undefined,
            packaged: undefined,
          },
          ["claude"],
        )
        expect(plan({ tests }, packages)).toMatchObject({ windows: true, macos: true })
      }
    })
  })

  context("when the change affects system packages", () => {
    it("tests those alone on Windows, in one job, and on macOS", () => {
      expect(plan(narrowed(["@novadeck/runner", "@novadeck/desktop"]), packages)).toEqual({
        windows: true,
        macos: true,
        held: false,
        windowsRows: systemWindows,
        windowsPackages: ["backend/runner", "apps/desktop"],
        macosRows: systemMacos,
        packages: ["backend/runner", "apps/desktop"],
      })
    })

    it("leaves the repository's own tests to `test:system`, which runs them anyway", () => {
      expect(plan(narrowed(["//", "@novadeck/terminal"]), packages)).toMatchObject({
        windowsPackages: ["libraries/terminal"],
        packages: ["libraries/terminal"],
      })
    })

    it("runs every test where it names one that is no package", () => {
      expect(plan(narrowed(["@novadeck/terminal", "@novadeck/gone"]), packages)).toMatchObject({
        windows: true,
        macos: true,
        windowsRows: wholeWindows,
        windowsPackages: [],
        macosRows: wholeMacos,
        packages: [],
      })
    })
  })

  context("when the change affects no system package", () => {
    it.each([
      ["neutral packages", []],
      ["the repository's tests alone", ["//"]],
    ])("runs Linux alone for %s", (_name, system) => {
      expect(plan(narrowed(system), packages)).toEqual({
        windows: false,
        macos: false,
        held: false,
        // Never run: a skipped job's matrix still has to be a list of rows.
        windowsRows: wholeWindows,
        windowsPackages: [],
        macosRows: wholeMacos,
        packages: [],
      })
    })
  })

  it("names the rows the steps read, each on Windows", () => {
    for (const row of [...wholeWindows, ...systemWindows]) {
      expect(row.os).toBe("windows-latest")
      expect(row.name).toMatch(/^Test \(Windows(, [1-3]\/3)?\)$/)
    }
    expect(wholeWindows.map(({ command }) => command)).toEqual([
      "npm run test:shard1",
      "npm run test:shard2",
      "npm run test:shard3",
    ])
    expect(systemWindows).toMatchObject([{ shard: 0, command: "npm run test:system" }])
    for (const row of [...wholeMacos, ...systemMacos])
      expect(row).toMatchObject({ name: "Test (macOS)", os: "macos-latest", shard: 0 })
  })
})

describe("Quality on a draft", () => {
  const runner = { ...narrowed(["@novadeck/runner"]), draft: true }

  it("holds macOS back where its change needs macOS, and runs Windows", () => {
    expect(plan(runner, packages)).toMatchObject({ windows: true, macos: false, held: true })
    expect(plan({ tests: all, draft: true }, packages)).toMatchObject({
      windows: true,
      macos: false,
      held: true,
    })
  })

  it("holds nothing where its change needs no macOS", () => {
    expect(plan({ ...narrowed([]), draft: true }, packages)).toMatchObject({
      macos: false,
      held: false,
    })
  })

  it("runs macOS once the pull request is ready, and where no payload says draft", () => {
    expect(plan({ ...runner, draft: false }, packages)).toMatchObject({ macos: true, held: false })
    const { draft: _, ...unsaid } = runner
    expect(plan(unsaid, packages)).toMatchObject({ macos: true, held: false })
  })
})

describe("test:system's turbo runs", () => {
  const folders = ["libraries/terminal", "backend/runner", "apps/desktop", "harnesses/claude"]

  it("run every package one at a time on macOS", () => {
    expect(invocations(folders, "darwin")).toEqual([{ folders, concurrency: 1 }])
  })

  it.each(["win32", "linux"] as const)(
    "run as the root's `test` on %s: the rest together, then the UI's, apps' and runner one at a time",
    (platform) => {
      expect(invocations(folders, platform)).toEqual([
        { folders: ["libraries/terminal", "harnesses/claude"] },
        { folders: ["backend/runner", "apps/desktop"], concurrency: 1 },
      ])
    },
  )

  it("leave out a group with nothing in it", () => {
    expect(invocations(["libraries/terminal"], "win32")).toEqual([
      { folders: ["libraries/terminal"] },
    ])
    expect(invocations(["frontend/terminal-views"], "win32")).toEqual([
      { folders: ["frontend/terminal-views"], concurrency: 1 },
    ])
    expect(invocations([], "darwin")).toEqual([])
  })
})

describe("the packages a system's test job runs", () => {
  it("are those that declare themselves system, and those that declare nothing it can read", () => {
    expect(systemPackages(packages).map(({ folder }) => folder)).toEqual([
      "apps/desktop",
      "backend/runner",
      "libraries/terminal",
      "libraries/clipboard",
      "libraries/fonts",
    ])
  })

  it("are the plan's list, when it names one", () => {
    expect(testedFolders('["apps/desktop"]', packages)).toEqual(["apps/desktop"])
    expect(filters(["apps/desktop"])).toEqual(["--filter=./apps/desktop"])
  })

  it.each([
    ["names none", undefined],
    ["is empty", ""],
    ["is an empty list", "[]"],
    ["isn't JSON", "apps/desktop"],
    ["names a folder that is no package", '["apps/desktop", "apps/gone"]'],
  ])("are every system package when the list %s", (_name, named) => {
    expect(testedFolders(named, packages)).toEqual(systemFolders)
  })

  it("leave no neutral package of the workspace in, and every system one", () => {
    const workspace = workspacePackages(root)
    // Without pnpm's check of the install, which prints to stdout ahead of turbo's JSON when it
    // finds the workspace's state stale, as after a rebase.
    const out = execFileSync(
      "pnpm",
      [
        "--config.verify-deps-before-run=false",
        "exec",
        "turbo",
        "run",
        "test",
        "--dry=json",
        ...filters(testedFolders(undefined, workspace)),
      ],
      { cwd: root, encoding: "utf8" },
    )
    const chosen = new Set((JSON.parse(out) as { packages: string[] }).packages)
    const names = (list: readonly Package[]) => list.map(({ manifest }) => manifest.name as string)
    const system = new Set(names(systemPackages(workspace)))
    expect([...chosen].toSorted()).toEqual([...system].toSorted())
    // The ones whose real processes, PTY or Electron main #784's macOS entries name.
    for (const name of [
      "@novadeck/runner",
      "@novadeck/sandbox",
      "@novadeck/desktop",
      "@novadeck/relay",
    ])
      expect(system.has(name)).toBe(true)
  })
})

describe("test:system's turbo arguments", () => {
  it("stop at the first package that fails, as a test job runs them", () => {
    expect(turboTestArgs({ folders: ["backend/runner"], concurrency: 1 }, false)).toEqual([
      "turbo",
      "run",
      "test",
      "--output-logs=new-only",
      "--concurrency=1",
      "--filter=./backend/runner",
      "--",
      "--reporter=default",
      "--reporter=hanging-process",
    ])
  })

  it("run every package's tests though one fails, as a proof row runs them", () => {
    expect(turboTestArgs({ folders: ["tools/atlas"] }, true, ["--bail=1"])).toEqual([
      "turbo",
      "run",
      "test",
      "--output-logs=new-only",
      "--continue",
      "--filter=./tools/atlas",
      "--",
      "--reporter=default",
      "--reporter=hanging-process",
      "--bail=1",
    ])
  })

  it("are what test:system hands turbo, reading whether to continue from the proof rows' env", () => {
    const script = readFileSync(join(root, "scripts", "quality", "plan", "system-tests.ts"), "utf8")
    expect(script).toContain('process.env.NOVADECK_TEST_CONTINUE === "true"')
    expect(script).toContain("turboTestArgs(")
    expect(script).toContain("if (!keepGoing) break")
  })
})

describe("the proof rows", () => {
  const never = () => false
  it.each([
    ".github/workflows/quality.yml",
    "scripts/quality/plan/plan.ts",
    "scripts/ci/plan/main.ts",
    "scripts/workspace/platform.ts",
    "package.json",
    "turbo.json",
    "backend/runner/turbo.json",
    "pnpm-workspace.yaml",
  ])("run for a pull request that changes %s", (file) => {
    expect(proves(["backend/runner/src/app.ts", file], never)).toBe(true)
  })

  it.each([
    ["a package's file", ["backend/runner/src/app.ts"]],
    ["another workflow", [".github/workflows/e2e.yml"]],
    ["nothing", []],
  ])("don't run for a change to %s", (_name, files) => {
    expect(proves(files, () => true)).toBe(false)
  })

  it("run for a package's manifest only where its declaration changed", () => {
    const asked: string[] = []
    const changedHere = (manifest: string) => (asked.push(manifest), manifest.startsWith("tools/"))
    expect(proves(["frontend/ui/package.json"], changedHere)).toBe(false)
    expect(proves(["frontend/ui/package.json", "tools/atlas/package.json"], changedHere)).toBe(true)
    expect(asked).toEqual([
      "frontend/ui/package.json",
      "frontend/ui/package.json",
      "tools/atlas/package.json",
    ])
  })

  it("don't run where the changed files couldn't be read: every test runs then", () => {
    expect(proves(undefined, () => true)).toBe(false)
  })

  context("a package's declaration", () => {
    const manifest = (fields: object) =>
      JSON.stringify({ name: "@novadeck/x", version: "1.0.0", ...fields })
    it("is the same where only its dependencies or version moved", () => {
      expect(
        declarationDiffers(
          manifest({ novadeck: { platform: "system" }, dependencies: { a: "1" } }),
          manifest({
            novadeck: { platform: "system" },
            dependencies: { a: "2" },
            version: "1.1.0",
          }),
        ),
      ).toBe(false)
    })

    it.each([
      ["its platform", { novadeck: { platform: "system" } }, { novadeck: { platform: "neutral" } }],
      [
        "what it reads",
        { novadeck: { reads: ["apps"] } },
        { novadeck: { reads: ["apps", "frontend"] } },
      ],
      ["a declaration added", {}, { novadeck: { platform: "neutral" } }],
    ])("differs where %s changed", (_name, before, after) => {
      expect(declarationDiffers(manifest(before), manifest(after))).toBe(true)
    })

    it.each([
      ["a package added", undefined, "{}"],
      ["a package removed", "{}", undefined],
      ["a manifest that isn't JSON", "{}", "{"],
    ])("differs for %s, as can't be told", (_name, before, after) => {
      expect(declarationDiffers(before, after)).toBe(true)
    })
  })

  it("are a system's narrowed row over each change's packages, under a name of its own", () => {
    const lists = { runner: ["backend/runner"], relay: ["backend/relay", "backend/runner"] }
    for (const [system, row, label] of [
      ["windows", systemWindows[0], "Windows"],
      ["macos", systemMacos[0], "macOS"],
    ] as const)
      expect(proofRows(system, lists)).toEqual(
        proofChanges.map(({ key }) => ({
          ...row,
          name: `Proof (${label}, ${key})`,
          proof: key,
          // One the plan couldn't narrow tests every system package (`testedFolders`).
          packages: lists[key as keyof typeof lists] ?? [],
        })),
      )
  })

  it("change files of system packages, each another", () => {
    const system = new Set(systemPackages(workspacePackages(root)).map(({ folder }) => folder))
    for (const { change } of proofChanges)
      expect(
        [...system].some((folder) => change.startsWith(`${folder}/`)),
        change,
      ).toBe(true)
    expect(new Set(proofChanges.map(({ change }) => change)).size).toBe(proofChanges.length)
  })

  // Git alone, no turbo: what the plan job plans each proof row from.
  it("plan each from a commit on the head that changes its file alone, moving nothing", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    const before = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
    const commit = changeCommit(head, proofChanges[0]!.change)
    const changed = execFileSync("git", ["diff", "--name-only", head, commit], {
      cwd: root,
      encoding: "utf8",
    })
    expect(changed.trim().split("\n")).toEqual([proofChanges[0]!.change])
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe(
      before,
    )
  })
})

describe("the plan script", () => {
  // CI runs it with plain node: what it imports must load that way too.
  it("runs under plain node and plans every system for a run that isn't a pull request", () => {
    const script = join(import.meta.dirname, "main.ts")
    const env = { ...process.env, GITHUB_EVENT_NAME: "schedule", GITHUB_OUTPUT: "" }
    const printed = execFileSync(process.execPath, [script], { env, encoding: "utf8" })
    expect(JSON.parse(printed)).toMatchObject({ windows: true, macos: true })
  })
})

describe("Quality's Test gate", () => {
  const passed = {
    PLAN_RESULT: "success",
    QUALITY_RESULT: "success",
    WINDOWS_PLANNED: "true",
    WINDOWS_RESULT: "success",
    MACOS_PLANNED: "true",
    MACOS_RESULT: "success",
    MACOS_HELD: "false",
  }
  const gate = (env: Partial<typeof passed>) => runGate("quality.yml", { ...passed, ...env })
  const draft = { MACOS_PLANNED: "false", MACOS_RESULT: "skipped", MACOS_HELD: "true" }

  it("fails on a draft whose change needs macOS, saying so in one line, with Linux green", () => {
    const { passed: ok, said } = gate(draft)
    expect(ok).toBe(false)
    expect(said).toBe("::error title=Draft::draft: macOS not run, mark ready to run it")
  })

  it("passes on a draft whose change needs no macOS", () => {
    expect(gate({ ...draft, MACOS_HELD: "false" }).passed).toBe(true)
  })

  it("names Linux's failure first on a draft", () => {
    expect(gate({ ...draft, QUALITY_RESULT: "failure" }).said).toContain("Checks and Linux tests")
  })

  it("passes when every job ran and passed", () => {
    expect(gate({}).passed).toBe(true)
  })

  it("passes when the plan left Windows and macOS out and they were skipped", () => {
    const env = { WINDOWS_PLANNED: "false", WINDOWS_RESULT: "skipped" }
    expect(gate({ ...env, MACOS_PLANNED: "false", MACOS_RESULT: "skipped" }).passed).toBe(true)
  })

  // What Actions reports in the cases that matter most.
  it("fails when Linux failed, and macOS never started", () => {
    expect(gate({ QUALITY_RESULT: "failure", MACOS_RESULT: "skipped" }).passed).toBe(false)
  })

  it("fails when a newer push cancelled the run while macOS waited for Linux", () => {
    expect(gate({ QUALITY_RESULT: "cancelled", MACOS_RESULT: "skipped" }).passed).toBe(false)
    expect(gate({ WINDOWS_RESULT: "cancelled", MACOS_RESULT: "cancelled" }).passed).toBe(false)
  })

  // Without a plan's outputs, `!= 'false'` reads both as planned: every test runs there.
  it("passes when the plan job failed and Windows and macOS ran every test and passed", () => {
    const { passed: ok, said } = gate({ PLAN_RESULT: "failure" })
    expect(ok).toBe(true)
    expect(said).toBe("::warning title=Plan::Plan: failure, so Windows and macOS ran every test")
  })

  it("fails when the plan job failed and Windows or macOS didn't run", () => {
    expect(gate({ PLAN_RESULT: "failure", MACOS_RESULT: "skipped" }).passed).toBe(false)
    expect(gate({ PLAN_RESULT: "failure", WINDOWS_RESULT: "failure" }).passed).toBe(false)
  })

  it("passes when the plan said to skip macOS and it was skipped", () => {
    expect(gate({ MACOS_PLANNED: "false", MACOS_RESULT: "skipped" }).passed).toBe(true)
  })

  it.each([
    [
      "the plan was cancelled, and the jobs with it",
      { PLAN_RESULT: "cancelled", WINDOWS_RESULT: "cancelled", MACOS_RESULT: "cancelled" },
    ],
    ["a check or a Linux test failed", { QUALITY_RESULT: "failure" }],
    ["the Linux jobs were cancelled", { QUALITY_RESULT: "cancelled" }],
    ["Windows failed", { WINDOWS_RESULT: "failure" }],
    ["macOS was cancelled", { MACOS_RESULT: "cancelled" }],
    // Planned, but skipped: Linux failed first, or a condition went wrong.
    ["macOS was planned and skipped", { MACOS_RESULT: "skipped" }],
    ["Windows was planned and skipped", { WINDOWS_RESULT: "skipped" }],
  ])("fails when %s", (_name, env) => {
    expect(gate(env).passed).toBe(false)
  })
})

describe("Quality's workflow", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "quality.yml"), "utf8")
  const job = (id: string): string => {
    const start = workflow.indexOf(`\n  ${id}:\n`)
    const end = workflow.indexOf("\n  # ", start + 1)
    return workflow.slice(start, end < 0 ? undefined : end)
  }

  it("starts macOS's tests only once every Linux job has passed", () => {
    expect(job("macos")).toContain("needs: [plan, quality]")
    expect(job("quality")).not.toMatch(/os: (macos|windows)-latest/)
  })

  it("runs on macOS only the packages that touch the system, by the plan's script", () => {
    expect(systemMacos).toMatchObject([{ name: "Test (macOS)", command: "npm run test:system" }])
    const scripts = (
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        scripts: Record<string, string>
      }
    ).scripts
    expect(scripts["test:system"]).toContain("scripts/quality/plan/system-tests.ts")
  })

  // Known Flakes reads the tests a retry passed from these artifacts (scripts/flakes/retries.ts):
  // a test job without the step hides its flakes in a green run.
  it("uploads the tests a retry passed from every test job, under a name of its own", () => {
    const shared = job("quality").slice(job("quality").indexOf("steps: &steps"))
    expect(shared).toContain("- name: Upload Retried Tests")
    expect(shared).toContain(
      "name: retried-${{ runner.os }}${{ matrix.shard && format('-{0}', matrix.shard) || '' }}-${{ github.run_attempt }}",
    )
    for (const id of ["windows", "macos"]) expect(job(id)).toContain("    steps: *steps\n")
  })

  // A plan that failed, or left its outputs out, runs every test there: it skips a system only
  // where it said so.
  it("skips Windows's and macOS's tests only where the plan said to", () => {
    expect(job("windows")).toContain(
      "if: ${{ !cancelled() && needs.plan.outputs.windows != 'false' }}",
    )
    expect(job("macos")).toContain(
      "if: ${{ !cancelled() && needs.quality.result == 'success' && needs.plan.outputs.macos != 'false' }}",
    )
    expect(job("test")).toContain("WINDOWS_PLANNED: ${{ needs.plan.outputs.windows != 'false' }}")
    expect(job("test")).toContain("MACOS_PLANNED: ${{ needs.plan.outputs.macos != 'false' }}")
  })

  it("runs every test on Windows and macOS where the plan's rows are missing", () => {
    const fallback = (id: string, output: string): unknown => {
      const line = job(id)
        .split("\n")
        .find((each) => each.includes(`fromJSON(needs.plan.outputs.${output} || '`))
      return JSON.parse(line!.slice(line!.indexOf("|| '") + 4, line!.lastIndexOf("')")))
    }
    expect(fallback("windows", "windows-rows")).toEqual(wholeWindows)
    expect(fallback("macos", "macos-rows")).toEqual(wholeMacos)
  })

  it("runs again when a draft is marked ready, and reads whether it is one", () => {
    expect(workflow).toContain("types: [opened, synchronize, reopened, ready_for_review]")
    expect(job("plan")).toContain("DRAFT: ${{ github.event.pull_request.draft }}")
    expect(job("test")).toContain("MACOS_HELD: ${{ needs.plan.outputs.held }}")
  })

  // On every run, a pushed draft's included, and on a ready one that needs no macOS, whose
  // gate passes: Package starts once, from Quality's gate, never on its own.
  it("runs Package once a run's gate passes, and from nowhere else", () => {
    const pkg = readFileSync(join(root, ".github", "workflows", "package.yml"), "utf8")
    const triggers = pkg.slice(pkg.indexOf("\non:\n"), pkg.indexOf("\npermissions:"))
    expect(triggers).toContain("workflow_call:")
    expect(triggers).not.toMatch(/pull_request|push:|ready_for_review/)
    expect(workflow.match(/uses: \.\/\.github\/workflows\/package\.yml/g)).toHaveLength(1)
    expect(job("package")).toContain("needs: test")
    expect(job("package")).toContain("needs.test.result == 'success'")
  })

  it("passes a ready pull request's gate when its change needs no macOS", () => {
    const env = {
      PLAN_RESULT: "success",
      QUALITY_RESULT: "success",
      WINDOWS_PLANNED: "false",
      WINDOWS_RESULT: "skipped",
      MACOS_PLANNED: "false",
      MACOS_RESULT: "skipped",
      MACOS_HELD: "false",
    }
    expect(runGate("quality.yml", env).passed).toBe(true)
  })

  it("has the gate wait on every test job", () => {
    expect(job("test")).toContain("needs: [plan, quality, windows, macos]")
  })

  it("takes Windows's and macOS's rows and packages from the plan", () => {
    expect(job("windows")).toContain("include: ${{ fromJSON(needs.plan.outputs.windows-rows || '")
    expect(job("macos")).toContain("include: ${{ fromJSON(needs.plan.outputs.macos-rows || '")
    expect(job("windows")).toContain(
      "NOVADECK_TEST_PACKAGES: ${{ needs.plan.outputs.windows-packages }}",
    )
    expect(job("macos")).toContain("NOVADECK_TEST_PACKAGES: ${{ needs.plan.outputs.packages }}")
    for (const output of ["windows-rows", "windows-packages", "macos-rows", "packages"])
      expect(job("plan")).toContain(`${output}: \${{ steps.plan.outputs.${output} }}`)
  })

  it("runs the proof rows where the plan says, every package's tests, macOS after Linux", () => {
    expect(job("proof-windows")).toContain("needs: plan\n")
    expect(job("proof-windows")).toContain(
      "if: ${{ !cancelled() && needs.plan.outputs.proof == 'true' }}",
    )
    expect(job("proof-macos")).toContain("needs: [plan, quality]")
    expect(job("proof-macos")).toContain(
      "if: ${{ !cancelled() && needs.quality.result == 'success' && needs.plan.outputs.proof-macos == 'true' }}",
    )
    for (const [id, output] of [
      ["proof-windows", "proof-windows-rows"],
      ["proof-macos", "proof-macos-rows"],
    ] as const) {
      expect(job(id)).toContain(`include: \${{ fromJSON(needs.plan.outputs.${output}) }}`)
      expect(job(id)).toContain("NOVADECK_TEST_PACKAGES: ${{ toJSON(matrix.packages) }}")
      expect(job(id)).toContain('NOVADECK_TEST_CONTINUE: "true"')
      expect(job(id)).toContain("    steps: *steps\n")
    }
    for (const output of ["proof", "proof-macos", "proof-windows-rows", "proof-macos-rows"])
      expect(job("plan")).toContain(`${output}: \${{ steps.plan.outputs.${output} }}`)
  })

  // Not required: they find out, and the gate judges the change's own tests.
  it("leaves the proof rows out of the gate, and their artifacts out of Known Flakes'", () => {
    expect(job("test")).not.toContain("proof")
    const shared = job("quality").slice(job("quality").indexOf("steps: &steps"))
    expect(shared).toContain(
      "if: ${{ !cancelled() && hashFiles('test-results/retried/**') != '' && env.NOVADECK_TEST_CONTINUE != 'true' }}",
    )
    expect(shared).toContain(
      "if: failure() && matrix.browser && env.NOVADECK_TEST_CONTINUE != 'true'",
    )
  })

  it("gives each row's tests their time: macOS's whole suite 57, its system packages 37", () => {
    expect(job("quality")).toContain(
      "runner.os == 'macOS' && (matrix.command == 'npm run test' && 57 || 37) || runner.os == 'Windows' && matrix.shard == 0 && 22 ||",
    )
    expect(job("macos")).toContain(
      "timeout-minutes: ${{ matrix.command == 'npm run test' && 60 || 40 }}",
    )
    expect(wholeMacos).toMatchObject([{ name: "Test (macOS)", command: "npm run test" }])
  })
})

// Inert until main requires a merge queue (architecture/ci-plan/merge-queue.md): every required
// check must report on a group, and nothing may assume a pull request there.
describe("the workflows on a merge queue's group", () => {
  const read = (name: string) =>
    readFileSync(join(root, ".github", "workflows", `${name}.yml`), "utf8")
  const triggers = (text: string) =>
    text.slice(text.indexOf("\non:\n"), text.indexOf("\npermissions:"))

  it.each(["quality", "e2e", "pr", "benchmark"])("runs %s", (name) => {
    expect(triggers(read(name))).toMatch(/\n {2}merge_group:\n/)
  })

  // An empty pull request number would put every group in one concurrency group, each
  // cancelling the one ahead of it.
  it.each(["quality", "e2e", "pr", "benchmark"])(
    "keys %s's concurrency by more than a pull request",
    (name) => {
      expect(read(name)).toMatch(
        /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.(ref|run_id|sha) \}\}/,
      )
    },
  )

  it.each(["quality", "e2e"])("plans %s from the group's base and head", (name) => {
    expect(read(name)).toContain(
      "BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}",
    )
    expect(read(name)).toContain(
      "HEAD_SHA: ${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}",
    )
  })

  // `null == false` holds in Actions' expressions, so the draft test alone packages a group.
  it("never packages a group", () => {
    expect(read("quality")).toContain(
      "github.event_name == 'pull_request' && github.event.pull_request.draft == false",
    )
  })

  it("has Verify read the group's pull request from its branch", () => {
    expect(read("pr")).toContain("MERGE_GROUP_HEAD_REF: ${{ github.event.merge_group.head_ref }}")
  })
})
