import { execFileSync } from "node:child_process"
import { join } from "node:path"

import { context, describe, expect, it } from "../../test"
import { type Facts, parseAffected, plan, quirks, select, setups } from "./plan.ts"

const ids = ["claude", "codex", "agy"]
const pullRequest = (affected: readonly string[], files: readonly string[] = []): Facts => ({
  event: "pull_request",
  affected,
  files,
})

describe("E2E selection", () => {
  context("when nobody is waiting on a change", () => {
    it("runs everything on the nightly schedule", () => {
      expect(select({ event: "schedule", affected: [], files: [] }, ids)).toEqual(ids)
    })

    it("runs everything on a manual dispatch", () => {
      expect(
        select({ event: "workflow_dispatch", affected: undefined, files: undefined }, ids),
      ).toEqual(ids)
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
      expect(select(pullRequest(["@novadeck/harness-other"]), ids)).toEqual(ids)
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
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "turbo.json",
    ])("runs everything for %s", (file) => {
      expect(select(pullRequest([], ["README.md", file]), ids)).toEqual(ids)
    })
  })

  context("when a pull request changes a package no rule names", () => {
    it("runs everything, as one the runner may build on", () => {
      const affected = ["@novadeck/new-engine", "@novadeck/runner"]
      expect(select(pullRequest(affected, ["engines/new-engine/index.ts"]), ids)).toEqual(ids)
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

  context("when the facts are missing", () => {
    it("runs everything without turbo's answer", () => {
      expect(
        select({ event: "pull_request", affected: undefined, files: ["README.md"] }, ids),
      ).toEqual(ids)
    })

    it("runs everything without git's answer", () => {
      expect(select({ event: "pull_request", affected: [], files: undefined }, ids)).toEqual(ids)
    })
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
    const facts: Facts = { event: "pull_request", affected: parseAffected("oops"), files: [] }
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

  it("names every row, for skipped jobs, when nothing is selected", () => {
    const planned = plan(pullRequest([], ["README.md"]), ids)
    expect(planned.run).toBe(false)
    const everything = plan({ event: "schedule", affected: [], files: [] }, ids)
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
    const planned = plan({ event: "schedule", affected: undefined, files: undefined }, ids)
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
