import { execFileSync } from "node:child_process"
import { join } from "node:path"

import { context, describe, expect, it } from "../../test"
import {
  type Facts,
  parseAffected,
  plan,
  quirks,
  select,
  selectSystems,
  setups,
  systems,
} from "./plan.ts"

const ids = ["claude", "codex", "agy"]
// What `turbo ls --filter @novadeck/runner...` names: the runner and what it builds on.
const runner = [
  "@novadeck/runner",
  "@novadeck/harness-core",
  "@novadeck/harness-claude",
  "@novadeck/harness-codex",
  "@novadeck/harness-agy",
  "@novadeck/protocol",
  "@novadeck/relay",
  "@novadeck/terminal",
  "@novadeck/emulator",
  "@novadeck/wire",
  "@novadeck/sandbox",
  "@novadeck/whisper",
  "@novadeck/murmur",
  "@novadeck/ggml-build",
]
const pullRequest = (affected: readonly string[], files: readonly string[] = []): Facts => ({
  event: "pull_request",
  affected,
  runner,
  files,
})
const nightly: Facts = {
  event: "schedule",
  affected: undefined,
  runner: undefined,
  files: undefined,
}

describe("E2E selection", () => {
  context("when nobody is waiting on a change", () => {
    it("runs everything on the nightly schedule", () => {
      expect(select({ ...nightly, affected: [], runner, files: [] }, ids)).toEqual(ids)
    })

    it("runs everything on a manual dispatch", () => {
      expect(select({ ...nightly, event: "workflow_dispatch" }, ids)).toEqual(ids)
    })
  })

  context("when a pull request changes adapters", () => {
    it("runs the harness of one adapter", () => {
      expect(select(pullRequest(["@novadeck/harness-codex"]), ids)).toEqual(["codex"])
    })

    it("runs only that harness when the runner is affected through its dependency", () => {
      const affected = ["@novadeck/harness-codex", "@novadeck/runner", "@novadeck/host"]
      expect(select(pullRequest(affected, ["harnesses/codex/src/index.ts"]), ids)).toEqual([
        "codex",
      ])
    })

    it("runs each harness of two adapters, in the order of the pins", () => {
      expect(
        select(pullRequest(["@novadeck/harness-agy", "@novadeck/harness-claude"]), ids),
      ).toEqual(["claude", "agy"])
    })

    it("runs everything for an adapter no pin names yet, as for any package no rule names", () => {
      const facts = pullRequest(["@novadeck/harness-other"])
      expect(select({ ...facts, runner: [...runner, "@novadeck/harness-other"] }, ids)).toEqual(ids)
    })
  })

  context("when a pull request changes what every harness shares", () => {
    it.each([
      "@novadeck/harness-core",
      "@novadeck/protocol",
      "@novadeck/relay",
      "@novadeck/whisper",
      "@novadeck/murmur",
      "@novadeck/ggml-build",
    ])("runs everything for %s", (name) => {
      expect(select(pullRequest([name]), ids)).toEqual(ids)
    })

    it.each([
      "application/runner/src/e2e/harnesses.json",
      "application/runner/src/e2e/fixture.ts",
      "application/runner/src/harnesses/service.ts",
    ])("runs everything for the runner's %s", (file) => {
      const affected = ["@novadeck/runner", "@novadeck/host"]
      expect(select(pullRequest(affected, [file]), ids)).toEqual(ids)
    })

    it("runs everything for the runner beside one adapter", () => {
      const affected = ["@novadeck/harness-codex", "@novadeck/runner"]
      const files = ["harnesses/codex/src/index.ts", "application/runner/src/index.ts"]
      expect(select(pullRequest(affected, files), ids)).toEqual(ids)
    })

    it.each([
      ".github/workflows/e2e.yml",
      ".github/actions/e2e-harness-cache/save/action.yml",
      "scripts/e2e/plan/plan.ts",
      "scripts/e2e/install/main.ts",
      "patches/node-pty@1.2.0-beta.14.patch",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "turbo.json",
    ])("runs everything for %s", (file) => {
      expect(select(pullRequest([], ["README.md", file]), ids)).toEqual(ids)
    })

    it("runs xterm's browser patch as a change to the emulator, on Linux alone", () => {
      const patch = "libraries/emulator/patches/@xterm__xterm@6.0.0.patch"
      const affected = ["@novadeck/emulator", "@novadeck/runner", "@novadeck/ui"]
      expect(select(pullRequest(affected, [patch, "pnpm-lock.yaml"]), ids)).toEqual(ids)
      expect(selectSystems(pullRequest(affected, [patch, "pnpm-lock.yaml"]))).toEqual([
        systems.linux,
      ])
    })
  })

  context("when a pull request changes a package no rule names", () => {
    it("runs everything when the runner builds on it", () => {
      const facts = pullRequest(["@novadeck/new-engine", "@novadeck/runner"])
      const files = ["engines/new-engine/index.ts"]
      expect(select({ ...facts, files, runner: [...runner, "@novadeck/new-engine"] }, ids)).toEqual(
        ids,
      )
    })

    it("runs nothing when the runner doesn't build on it, as for the viewers", () => {
      const affected = ["@novadeck/viewers", "@novadeck/ui", "@novadeck/host"]
      expect(select(pullRequest(affected, ["libraries/viewers/src/index.ts"]), ids)).toEqual([])
    })
  })

  context("when a pull request changes nothing the suite runs on", () => {
    it("runs nothing for documentation alone", () => {
      expect(select(pullRequest([], ["docs/e2e-testing.md", "README.md"]), ids)).toEqual([])
    })

    it("runs nothing for the UI alone", () => {
      expect(select(pullRequest(["@novadeck/ui"], ["application/ui/src/app.tsx"]), ids)).toEqual([])
    })

    it("runs nothing for the host and the UI it bundles", () => {
      const affected = ["@novadeck/ui", "@novadeck/host"]
      expect(select(pullRequest(affected, ["application/host/src/main/index.ts"]), ids)).toEqual([])
    })

    it("runs nothing for other scripts or workflows", () => {
      expect(
        select(pullRequest([], ["scripts/dev-web/main.ts", ".github/workflows/quality.yml"]), ids),
      ).toEqual([])
    })
  })

  context("when a pull request changes a library the runner imports", () => {
    it.each([
      ["@novadeck/terminal", "libraries/terminal/src/pty/index.ts"],
      ["@novadeck/wire", "libraries/wire/src/index.ts"],
      ["@novadeck/sandbox", "libraries/sandbox/src/index.ts"],
    ])("runs everything for %s", (name, file) => {
      expect(select(pullRequest([name, "@novadeck/runner"], [file]), ids)).toEqual(ids)
    })
  })

  context("when the facts are missing", () => {
    it("runs everything without turbo's answer", () => {
      expect(select({ ...pullRequest([], ["README.md"]), affected: undefined }, ids)).toEqual(ids)
    })

    it("runs everything without the runner's packages", () => {
      expect(select({ ...pullRequest([], ["README.md"]), runner: undefined }, ids)).toEqual(ids)
    })

    it("runs everything without git's answer", () => {
      expect(select({ ...pullRequest([]), files: undefined }, ids)).toEqual(ids)
    })
  })
})

describe("E2E systems", () => {
  const all = [systems.linux, systems.windows, systems.macos]
  const linux = [systems.linux]

  it("runs all three on the nightly schedule and a manual dispatch", () => {
    expect(selectSystems(nightly)).toEqual(all)
    expect(selectSystems({ ...nightly, event: "workflow_dispatch" })).toEqual(all)
  })

  it("runs all three without git's answer", () => {
    expect(selectSystems({ ...pullRequest([]), files: undefined })).toEqual(all)
  })

  it.each([
    "application/runner/src/terminals/manager.ts",
    "libraries/terminal/src/pty/index.ts",
    "libraries/wire/src/index.ts",
    "libraries/emulator/src/headless.ts",
    "libraries/emulator/src/width.ts",
    "libraries/emulator/src/screen.ts",
    "libraries/emulator/package.json",
    "libraries/emulator/patches/@xterm__addon-unicode-graphemes@0.4.0.patch",
    "harnesses/claude/src/index.ts",
    "harnesses/core/src/index.ts",
    "application/relay/src/main.rs",
    "scripts/e2e/plan/plan.ts",
    ".github/workflows/e2e.yml",
    ".github/actions/e2e-harness-cache/save/action.yml",
    "libraries/sandbox/src/reap.ts",
    "libraries/sandbox/src/reap-lister.cs",
    "patches/node-pty@1.2.0-beta.14.patch",
  ])("runs all three for %s", (file) => {
    expect(selectSystems(pullRequest([], ["README.md", file]))).toEqual(all)
  })

  it.each([
    "application/protocol/src/harnesses.ts",
    "engines/whisper/src/index.ts",
    "pnpm-lock.yaml",
    "package.json",
    "pnpm-workspace.yaml",
    "turbo.json",
    "application/ui/src/app.tsx",
    "libraries/viewers/src/index.ts",
    "libraries/emulator/patches/@xterm__xterm@6.0.0.patch",
    "libraries/emulator/src/browser.ts",
    "libraries/emulator/src/browser.css",
    "libraries/emulator/src/view.ts",
    "libraries/emulator/src/renderer.test.ts",
  ])("runs Linux alone for %s", (file) => {
    expect(selectSystems(pullRequest([], [file]))).toEqual(linux)
  })

  it("runs all three when one file of several needs them", () => {
    expect(
      selectSystems(pullRequest([], ["pnpm-lock.yaml", "libraries/wire/src/index.ts"])),
    ).toEqual(all)
  })
})

// The jobs a plan starts: the `e2e` job's rows on each system, and the `quirks` job's on
// Windows.
const count = (planned: ReturnType<typeof plan>) => {
  if (!planned.run) return { jobs: 0, macos: 0 }
  const windows = planned.os.includes(systems.windows) ? planned.quirks.length : 0
  return {
    jobs: planned.os.length * planned.e2e.length + windows,
    macos: planned.os.includes(systems.macos) ? planned.e2e.length : 0,
  }
}

describe("E2E jobs by change", () => {
  const planFor = (affected: readonly string[], files: readonly string[]) =>
    count(plan(pullRequest(affected, files), ids))

  // Each row's jobs and macOS jobs: the `e2e` rows (a harness each, and Mixed) on each
  // system the plan chose, and a quirks row per harness when it chose Windows.
  it.each([
    ["the UI alone", ["@novadeck/ui", "@novadeck/host"], ["application/ui/src/app.tsx"], 0, 0],
    [
      "the viewers alone",
      ["@novadeck/viewers", "@novadeck/ui", "@novadeck/host"],
      ["libraries/viewers/src/index.ts"],
      0,
      0,
    ],
    [
      "libraries/wire",
      ["@novadeck/wire", "@novadeck/protocol", "@novadeck/runner"],
      ["libraries/wire/src/index.ts"],
      15,
      4,
    ],
    [
      "libraries/terminal",
      ["@novadeck/terminal", "@novadeck/runner"],
      ["libraries/terminal/src/index.ts"],
      15,
      4,
    ],
    ["the runner alone", ["@novadeck/runner"], ["application/runner/src/index.ts"], 15, 4],
    ["the lockfile alone", [], ["pnpm-lock.yaml"], 4, 0],
    [
      "harnesses/claude",
      ["@novadeck/harness-claude", "@novadeck/runner"],
      ["harnesses/claude/src/index.ts"],
      7,
      2,
    ],
    ["documentation alone", [], ["docs/e2e-testing.md"], 0, 0],
  ])("starts the jobs of %s", (_name, affected, files, jobs, macos) => {
    expect(planFor(affected, files)).toEqual({ jobs, macos })
  })

  // Step 2 moves the pty (T2) and the host (T4) into libraries/terminal and edits the
  // runner's terminals/manager.ts: both must run every row on every system.
  it("runs all three systems for a change to the pty and the runner's terminal manager", () => {
    const affected = ["@novadeck/terminal", "@novadeck/runner", "@novadeck/host"]
    const files = [
      "libraries/terminal/src/pty/index.ts",
      "libraries/terminal/package.json",
      "application/runner/src/terminals/manager.ts",
    ]
    const planned = plan(pullRequest(affected, files), ids)
    expect(planned.run).toBe(true)
    expect(planned.os).toEqual([systems.linux, systems.windows, systems.macos])
    expect(planned.e2e).toHaveLength(ids.length + 1)
    expect(planned.quirks).toHaveLength(ids.length)
  })
})

describe("E2E turbo output", () => {
  it("reads the package names", () => {
    const output = JSON.stringify({
      packages: { count: 2, items: [{ name: "a", path: "x" }, { name: "b" }] },
    })
    expect(parseAffected(output)).toEqual(["a", "b"])
  })

  it("reads an empty list", () => {
    expect(parseAffected('{"packages":{"count":0,"items":[]}}')).toEqual([])
  })

  it.each([
    "",
    "not json",
    "{}",
    '{"packages":{"items":"a"}}',
    '{"packages":{"items":[{"path":"x"}]}}',
    "null",
  ])("rejects %j", (output) => {
    expect(parseAffected(output)).toBeUndefined()
  })

  it("sends a plan running everything when the output is bad", () => {
    const facts: Facts = { ...pullRequest([]), affected: parseAffected("oops") }
    expect(plan(facts, ids).e2e).toHaveLength(ids.length + 1)
  })
})

describe("E2E rows", () => {
  it("names each selected harness, then Mixed over every harness", () => {
    expect(setups(["codex"], ids)).toEqual([
      { agents: "codex", name: "Codex" },
      { agents: "claude,codex,agy", name: "Mixed", files: "mixed.e2e.ts" },
    ])
  })

  it("names every system, for skipped jobs, when nothing is selected", () => {
    expect(plan(pullRequest([], ["README.md"]), ids).os).toEqual([
      systems.linux,
      systems.windows,
      systems.macos,
    ])
  })

  it("names every row, for skipped jobs, when nothing is selected", () => {
    const planned = plan(pullRequest([], ["README.md"]), ids)
    expect(planned.run).toBe(false)
    const everything = plan({ ...nightly, affected: [], runner, files: [] }, ids)
    expect(planned.e2e).toEqual(everything.e2e)
    expect(planned.quirks).toEqual(everything.quirks)
  })

  it("names a harness no one gave a name by its id", () => {
    expect(setups(["new"], ["new"])[0]).toEqual({ agents: "new", name: "new" })
  })

  it("gives the quirks job a row per selected harness and no Mixed", () => {
    expect(quirks(["claude", "agy"])).toEqual([
      {
        agents: "claude",
        name: "Claude Code",
        files: "messaging.e2e.ts requests.e2e.ts lifecycle.e2e.ts windows-quirks.e2e.ts",
      },
      {
        agents: "agy",
        name: "Antigravity",
        files: "messaging.e2e.ts requests.e2e.ts lifecycle.e2e.ts",
        autorun: true,
      },
    ])
  })

  it("plans everything for a nightly run", () => {
    const planned = plan(nightly, ids)
    expect(planned.run).toBe(true)
    expect(planned.e2e.map((setup) => setup.name)).toEqual([
      "Claude Code",
      "Codex",
      "Antigravity",
      "Mixed",
    ])
    expect(planned.quirks.map((row) => row.agents)).toEqual(ids)
  })
})

describe("the plan script", () => {
  // CI runs it with plain node, no package built: what it imports must load that way too.
  it("runs under plain node and plans every row for a nightly run", () => {
    const script = join(import.meta.dirname, "main.ts")
    const env = { ...process.env, GITHUB_EVENT_NAME: "schedule", GITHUB_OUTPUT: "" }
    const printed = execFileSync(process.execPath, [script], { env, encoding: "utf8" })
    const planned = JSON.parse(printed) as ReturnType<typeof plan>
    expect(planned.run).toBe(true)
    expect(planned.e2e.map((row) => row.name)).toEqual([
      "Claude Code",
      "Codex",
      "Antigravity",
      "Mixed",
    ])
  })
})
