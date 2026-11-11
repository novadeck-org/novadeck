import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { runGate } from "../../e2e/plan/gate.ts"
import { context, describe, expect, it } from "../../test"
import { type Package, workspacePackages } from "../../workspace/platform.ts"
import { type Facts, filters, plan, systemPackages, testedFolders } from "./plan.ts"

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
const pullRequest = (affected: readonly string[], files: readonly string[]): Facts => ({
  event: "pull_request",
  affected,
  files,
})
const systemFolders = systemPackages(packages).map(({ folder }) => folder)
const every = { windows: true, macos: true, held: false, packages: systemFolders }
const linuxAlone = { windows: false, macos: false, held: false, packages: systemFolders }

describe("Quality's systems", () => {
  context("when nobody is waiting on a change", () => {
    it("runs every system on a schedule, a dispatch or a push", () => {
      for (const event of ["schedule", "workflow_dispatch", "push"])
        expect(plan({ event, affected: [], files: [] }, packages)).toEqual(every)
    })

    it("runs every system without turbo's answer", () => {
      expect(plan({ ...pullRequest([], []), affected: undefined }, packages)).toEqual(every)
    })

    it("runs every system without git's answer", () => {
      expect(plan({ ...pullRequest([], []), files: undefined }, packages)).toEqual(every)
    })
  })

  context("when a pull request affects a package that touches the system", () => {
    it.each([
      ["the runner", ["@novadeck/runner"], ["backend/runner/src/terminals/manager.ts"]],
      ["the terminal library", ["@novadeck/terminal"], ["libraries/terminal/src/pty/index.ts"]],
      // A neutral package the runner builds on: the runner is affected, and runs everywhere.
      [
        "the protocol",
        ["@novadeck/protocol", "@novadeck/runner", "@novadeck/ui"],
        ["contract/protocol/src/harnesses.ts"],
      ],
      // The UI, which the desktop app bundles.
      ["the UI", ["@novadeck/ui", "@novadeck/desktop"], ["frontend/ui/src/app.tsx"]],
      ["a package that declares nothing", ["@novadeck/clipboard"], ["libraries/clipboard/a.ts"]],
      ["a package whose declaration is misspelled", ["@novadeck/fonts"], ["libraries/fonts/a.ts"]],
    ])("runs every system for %s", (_name, affected, files) => {
      expect(plan(pullRequest(affected, files), packages)).toEqual(every)
    })
  })

  context("when a pull request changes what every system runs its tests with", () => {
    it.each([
      ".github/workflows/quality.yml",
      "scripts/quality/plan/plan.ts",
      "scripts/install/install.sh",
      "package.json",
      "pnpm-lock.yaml",
      "turbo.json",
      "vitest.config.ts",
    ])("runs every system for %s, which is in no package", (file) => {
      expect(plan(pullRequest([], ["frontend/ui/src/app.tsx", file]), packages)).toEqual(every)
    })
  })

  context("when a pull request affects only neutral packages", () => {
    it.each([
      ["the specs", ["@novadeck/specs"], ["frontend/specs/src/views/grid.spec.tsx"]],
      ["the UI's prose", ["@novadeck/ui"], ["frontend/ui/README.md"]],
      ["documentation", [], ["docs/development.md", "README.md"]],
      ["nothing", [], []],
    ])("runs Linux alone for %s", (_name, affected, files) => {
      expect(plan(pullRequest(affected, files), packages)).toEqual(linuxAlone)
    })
  })
})

describe("Quality on a draft", () => {
  const runner = { ...pullRequest(["@novadeck/runner"], ["backend/runner/src/a.ts"]), draft: true }

  it("holds macOS back where its change needs macOS, and runs Windows", () => {
    expect(plan(runner, packages)).toMatchObject({ windows: true, macos: false, held: true })
  })

  // A ready pull request converted back to a draft and pushed to: its `synchronize` run reads
  // the payload's draft as any other run does.
  it("holds macOS back again for a pull request turned back into a draft and pushed to", () => {
    expect(plan({ ...runner, draft: false }, packages)).toMatchObject({ macos: true, held: false })
    expect(plan(runner, packages)).toMatchObject({ macos: false, held: true })
  })

  it("holds nothing where its change needs no macOS", () => {
    const ui = { ...pullRequest(["@novadeck/specs"], ["frontend/specs/a.spec.tsx"]), draft: true }
    expect(plan(ui, packages)).toMatchObject({ macos: false, held: false })
  })

  it("runs macOS once the pull request is ready, and where no payload says draft", () => {
    expect(plan({ ...runner, draft: false }, packages)).toMatchObject({ macos: true, held: false })
    const { draft: _, ...unsaid } = runner
    expect(plan(unsaid, packages)).toMatchObject({ macos: true, held: false })
    expect(
      plan({ event: "merge_group", affected: undefined, files: undefined }, packages),
    ).toMatchObject({
      macos: true,
      held: false,
    })
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
    const out = execFileSync(
      "pnpm",
      [
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

  it("fails when the plan job failed, and said nothing", () => {
    const silent = { WINDOWS_PLANNED: "", MACOS_PLANNED: "" }
    expect(
      gate({
        PLAN_RESULT: "failure",
        ...silent,
        WINDOWS_RESULT: "skipped",
        MACOS_RESULT: "skipped",
      }).passed,
    ).toBe(false)
  })

  it("passes when the plan said to skip macOS and it was skipped", () => {
    expect(gate({ MACOS_PLANNED: "false", MACOS_RESULT: "skipped" }).passed).toBe(true)
  })

  it.each([
    ["the plan failed", { PLAN_RESULT: "failure" }],
    ["the plan was cancelled", { PLAN_RESULT: "cancelled" }],
    ["a check or a Linux test failed", { QUALITY_RESULT: "failure" }],
    ["the Linux jobs were cancelled", { QUALITY_RESULT: "cancelled" }],
    ["Windows failed", { WINDOWS_RESULT: "failure" }],
    ["macOS was cancelled", { MACOS_RESULT: "cancelled" }],
    // Planned, but skipped: Linux failed first, or a condition went wrong.
    ["macOS was planned and skipped", { MACOS_RESULT: "skipped" }],
    ["Windows was planned and skipped", { WINDOWS_RESULT: "skipped" }],
    // No plan to read: the jobs were skipped without one saying so.
    ["the plan said nothing", { WINDOWS_PLANNED: "", WINDOWS_RESULT: "skipped" }],
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
    expect(job("macos")).toContain("command: npm run test:system")
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

  it("gates Windows's and macOS's tests on the plan", () => {
    expect(job("windows")).toContain("if: needs.plan.outputs.windows == 'true'")
    expect(job("macos")).toContain("if: needs.plan.outputs.macos == 'true'")
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
})
