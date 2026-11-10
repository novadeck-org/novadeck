import { systems } from "../../e2e/plan/plan.ts"
import { context, describe, expect, it } from "../../test"
import { affected, dependencies, graphOf } from "./graph.ts"
import { type Facts, packageOf, plan, type Workspace } from "./plan.ts"

const ids = ["claude", "codex", "agy"]

// A workspace shaped like the real one, small: the runner on the harnesses, a system library and
// a neutral one, the protocol; the UI and the desktop app on top.
const manifests = [
  { name: "@novadeck/protocol", dependencies: { "@novadeck/terminal": "workspace:*" } },
  { name: "@novadeck/terminal" },
  { name: "@novadeck/emulator" },
  { name: "@novadeck/harness-core", dependencies: { "@novadeck/protocol": "workspace:*" } },
  { name: "@novadeck/harness-claude", dependencies: { "@novadeck/harness-core": "workspace:*" } },
  { name: "@novadeck/harness-codex", dependencies: { "@novadeck/harness-core": "workspace:*" } },
  { name: "@novadeck/harness-agy", dependencies: { "@novadeck/harness-core": "workspace:*" } },
  {
    name: "@novadeck/runner",
    dependencies: {
      "@novadeck/emulator": "workspace:*",
      "@novadeck/harness-agy": "workspace:*",
      "@novadeck/harness-claude": "workspace:*",
      "@novadeck/harness-codex": "workspace:*",
      "@novadeck/terminal": "workspace:*",
    },
  },
  { name: "@novadeck/core", dependencies: { "@novadeck/protocol": "workspace:*" } },
  { name: "@novadeck/ui", dependencies: { "@novadeck/core": "workspace:*" } },
  { name: "@novadeck/specs", devDependencies: { "@novadeck/ui": "workspace:*" } },
  {
    name: "@novadeck/desktop",
    dependencies: { "@novadeck/runner": "workspace:*", "@novadeck/ui": "workspace:*" },
  },
]
const packages: readonly Workspace[] = [
  { name: "@novadeck/protocol", folder: "contract/protocol", platform: "neutral", reads: [] },
  { name: "@novadeck/terminal", folder: "libraries/terminal", platform: "system", reads: [] },
  { name: "@novadeck/emulator", folder: "libraries/emulator", platform: "neutral", reads: [] },
  { name: "@novadeck/harness-core", folder: "harnesses/core", platform: "system", reads: [] },
  { name: "@novadeck/harness-claude", folder: "harnesses/claude", platform: "system", reads: [] },
  { name: "@novadeck/harness-codex", folder: "harnesses/codex", platform: "system", reads: [] },
  { name: "@novadeck/harness-agy", folder: "harnesses/agy", platform: "system", reads: [] },
  { name: "@novadeck/runner", folder: "backend/runner", platform: "system", reads: [] },
  { name: "@novadeck/core", folder: "frontend/core", platform: "neutral", reads: [] },
  { name: "@novadeck/ui", folder: "frontend/ui", platform: "neutral", reads: [] },
  { name: "@novadeck/specs", folder: "frontend/specs", platform: "system", reads: [] },
  { name: "@novadeck/desktop", folder: "apps/desktop", platform: "system", reads: [] },
]
const graph = graphOf(manifests)

/** A pull request changing `files`, its other facts worked out as turbo would. */
const pullRequest = (...files: string[]): Facts => ({
  event: "pull_request",
  packages,
  scopes: [],
  files,
  affected: affected(
    graph,
    files.flatMap((file) => packageOf(file, packages)?.name ?? []),
  ),
  suite: dependencies(graph, "@novadeck/runner"),
  packaged: dependencies(graph, "@novadeck/desktop"),
})

const everySystem = [systems.linux, systems.windows, systems.macos]

describe("the CI plan", () => {
  context("when nothing narrows it", () => {
    it.each(["schedule", "workflow_dispatch", "push", ""])("runs everything on %j", (event) => {
      const decided = plan({ ...pullRequest("frontend/ui/src/a.ts"), event }, ids)
      expect(decided.everything).toBeDefined()
      expect(decided.tests).toEqual({ linux: "all", windows: "all", macos: "all" })
      expect(decided.e2e.run).toBe(true)
      expect(decided.e2e.os).toEqual(everySystem)
      expect(decided.package).toBe(true)
    })

    it.each([
      "pnpm-lock.yaml",
      "package.json",
      ".github/workflows/quality.yml",
      "scripts/e2e/plan/plan.ts",
      "docs/assets/screenshot.webp",
      // A folder that looks like a package but isn't one.
      "libraries/new-one/src/index.ts",
    ])("runs everything for a change to %s, outside every package", (file) => {
      const decided = plan(pullRequest("frontend/ui/src/a.ts", file), ids)
      expect(decided.everything).toBe(`${file} is outside every package`)
      expect(decided.tests.macos).toBe("all")
      expect(decided.e2e.e2e.map(({ agents }) => agents)).toEqual([...ids, ids.join(",")])
    })

    it.each(["packages", "affected", "files", "suite", "packaged"] as const)(
      "runs everything when the %s couldn't be read",
      (fact) => {
        const decided = plan({ ...pullRequest("frontend/ui/src/a.ts"), [fact]: undefined }, ids)
        expect(decided.everything).toBe(`the ${fact} couldn't be read`)
        expect(decided.tests.windows).toBe("all")
      },
    )

    it("runs everything when turbo names a package the workspace doesn't have", () => {
      const facts = pullRequest("frontend/ui/src/a.ts")
      const decided = plan({ ...facts, affected: [...facts.affected!, "@novadeck/gone"] }, ids)
      expect(decided.everything).toBe("@novadeck/gone isn't a workspace package")
    })

    it("runs everything when a changed package isn't among the affected", () => {
      const decided = plan({ ...pullRequest("frontend/ui/src/a.ts"), affected: [] }, ids)
      expect(decided.everything).toBe("@novadeck/ui changed but isn't affected")
    })
  })

  context("for a change to neutral packages alone", () => {
    const decided = plan(pullRequest("frontend/core/src/model.ts"), ids)

    it("runs the affected packages' tests on Linux, and the repository's own", () => {
      expect(decided.everything).toBeUndefined()
      expect(decided.tests.linux).toEqual([
        "//",
        "@novadeck/core",
        "@novadeck/desktop",
        "@novadeck/specs",
        "@novadeck/ui",
      ])
    })

    it("runs nothing on Windows and macOS, though system packages depend on them", () => {
      expect(decided.tests.windows).toEqual([])
      expect(decided.tests.macos).toEqual([])
    })

    it("runs no E2E row where the runner doesn't build on them", () => {
      expect(decided.e2e.run).toBe(false)
    })

    it("packages a change to the built code", () => {
      expect(decided.package).toBe(true)
    })
  })

  context("for a change to a system package", () => {
    const decided = plan(pullRequest("frontend/specs/src/a.spec.tsx"), ids)

    it("runs the affected system packages' tests on Windows and macOS too", () => {
      expect(decided.tests.linux).toEqual(["//", "@novadeck/specs"])
      expect(decided.tests.windows).toEqual(["@novadeck/specs"])
      expect(decided.tests.macos).toEqual(["@novadeck/specs"])
    })

    it("runs, beside it, only the affected system packages, not the neutral ones", () => {
      const both = plan(pullRequest("libraries/terminal/src/pty.ts", "frontend/core/src/a.ts"), ids)
      expect(both.tests.linux).toContain("@novadeck/core")
      expect(both.tests.macos).not.toContain("@novadeck/core")
      expect(both.tests.macos).not.toContain("@novadeck/ui")
      expect(both.tests.macos).toEqual(
        expect.arrayContaining(["@novadeck/terminal", "@novadeck/runner", "@novadeck/desktop"]),
      )
    })
  })

  context("for prose outside every package", () => {
    it("runs no package's tests, but the repository's on Linux", () => {
      const decided = plan(pullRequest("docs/development.md", "AGENTS.md"), ids)
      expect(decided.everything).toBeUndefined()
      expect(decided.tests).toEqual({ linux: ["//"], windows: [], macos: [] })
      expect(decided.e2e.run).toBe(false)
      expect(decided.package).toBe(false)
    })

    it("runs the packages that declare they read it", () => {
      const reader = packages.map((each) =>
        each.name === "@novadeck/ui" ? { ...each, reads: ["docs/development.md"] } : each,
      )
      const decided = plan({ ...pullRequest("docs/development.md"), packages: reader }, ids)
      expect(decided.tests.linux).toEqual(["//", "@novadeck/ui"])
    })

    it("runs everything where prose isn't narrowed, as the replay measures", () => {
      expect(plan(pullRequest("docs/development.md"), ids, { prose: false }).everything).toBe(
        "docs/development.md is outside every package",
      )
    })
  })

  context("for a folder outside every package with a scope", () => {
    const scoped = (...files: string[]): Facts => ({
      ...pullRequest(...files),
      scopes: [{ folder: "scripts/ratchet", reaches: "repository", why: "a test" }],
    })

    it("runs only the repository's tests, on Linux", () => {
      const decided = plan(scoped("scripts/ratchet/manager.json", "scripts/ratchet/a.ts"), ids)
      expect(decided.everything).toBeUndefined()
      expect(decided.tests).toEqual({ linux: ["//"], windows: [], macos: [] })
      expect(decided.e2e.run).toBe(false)
      expect(decided.package).toBe(false)
    })

    it("runs everything for a folder beside it that has none", () => {
      expect(
        plan(scoped("scripts/ratchet/ratchet.ts", "scripts/flakes/main.ts"), ids).everything,
      ).toBe("scripts/flakes/main.ts is outside every package")
    })

    it("runs the packages that declare they read it", () => {
      const facts = scoped("scripts/ratchet/manager.json")
      const reader = packages.map((each) =>
        each.name === "@novadeck/specs" ? { ...each, reads: ["scripts/ratchet"] } : each,
      )
      expect(plan({ ...facts, packages: reader }, ids).tests.linux).toEqual([
        "//",
        "@novadeck/specs",
      ])
    })
  })

  context("for a package that declares what else it reads", () => {
    const reader = packages.map((each) =>
      each.name === "@novadeck/core"
        ? { ...each, reads: ["backend/runner/src/terminals/handles.ts"] }
        : each,
    )

    it("runs its tests when what it reads changed, though it doesn't depend on it", () => {
      const decided = plan(
        { ...pullRequest("backend/runner/src/terminals/handles.ts"), packages: reader },
        ids,
      )
      expect(decided.tests.linux).toContain("@novadeck/core")
    })

    it("runs no package that depends on it for that", () => {
      const decided = plan(
        { ...pullRequest("backend/runner/src/terminals/handles.ts"), packages: reader },
        ids,
      )
      expect(decided.tests.linux).not.toContain("@novadeck/ui")
    })

    it("doesn't run them for a change elsewhere in the same package", () => {
      const decided = plan(
        { ...pullRequest("backend/runner/src/manager.ts"), packages: reader },
        ids,
      )
      expect(decided.tests.linux).not.toContain("@novadeck/core")
    })
  })

  context("without the gate on Windows and macOS, as the replay measures", () => {
    it("runs every affected system package there for a neutral change", () => {
      const decided = plan(pullRequest("frontend/core/src/model.ts"), ids, { gate: false })
      expect(decided.tests.macos).toEqual(["@novadeck/desktop", "@novadeck/specs"])
    })
  })

  context("for the E2E suite", () => {
    it("runs every harness on every system for a change to the runner", () => {
      const { e2e } = plan(pullRequest("backend/runner/src/manager.ts"), ids)
      expect(e2e.run).toBe(true)
      expect(e2e.os).toEqual(everySystem)
      expect(e2e.e2e.map(({ agents }) => agents)).toEqual([...ids, ids.join(",")])
    })

    it("runs every harness for a change to the runner's own tests", () => {
      const { e2e } = plan(pullRequest("backend/runner/src/e2e/chat.e2e.ts"), ids)
      expect(e2e.e2e.map(({ agents }) => agents)).toEqual([...ids, ids.join(",")])
    })

    it("runs one harness, and Mixed, on every system for a change to its adapter", () => {
      const { e2e } = plan(pullRequest("harnesses/codex/src/index.ts"), ids)
      expect(e2e.e2e.map(({ agents }) => agents)).toEqual(["codex", ids.join(",")])
      expect(e2e.os).toEqual(everySystem)
      expect(e2e.quirks.map(({ agents }) => agents)).toEqual(["codex"])
    })

    it("runs every harness for a change to what they share", () => {
      const { e2e } = plan(pullRequest("harnesses/core/src/harness.ts"), ids)
      expect(e2e.e2e.map(({ agents }) => agents)).toEqual([...ids, ids.join(",")])
    })

    it("runs every harness on Linux alone for a neutral package the runner builds on", () => {
      const { e2e } = plan(pullRequest("contract/protocol/src/schema.ts"), ids)
      expect(e2e.run).toBe(true)
      expect(e2e.os).toEqual([systems.linux])
      expect(e2e.rows.every(({ os }) => os === systems.linux)).toBe(true)
    })

    it("runs on every system where a system package beside it changed", () => {
      const { e2e } = plan(
        pullRequest("libraries/emulator/src/cell.ts", "libraries/terminal/src/pty.ts"),
        ids,
      )
      expect(e2e.os).toEqual(everySystem)
    })

    it("still names every row when nothing runs, as Actions refuses an empty matrix", () => {
      const { e2e } = plan(pullRequest("frontend/ui/src/a.ts"), ids)
      expect(e2e.run).toBe(false)
      expect(e2e.rows.length).toBeGreaterThan(0)
      expect(e2e.quirks.map(({ agents }) => agents)).toEqual(ids)
    })
  })

  context("for packaging", () => {
    it("packages nothing for tests, specs and prose alone", () => {
      expect(
        plan(
          pullRequest(
            "frontend/ui/src/a.test.ts",
            "backend/runner/src/e2e/chat.e2e.ts",
            "frontend/ui/README.md",
            "frontend/ui/src/specs/x.ts",
          ),
          ids,
        ).package,
      ).toBe(false)
    })

    it("packages nothing for a package the app isn't built from", () => {
      expect(plan(pullRequest("frontend/specs/src/support/a.ts"), ids).package).toBe(false)
    })

    it("packages a change to a patch in a package the app is built from", () => {
      expect(
        plan(pullRequest("libraries/terminal/patches/node-pty@1.2.0.patch"), ids).package,
      ).toBe(true)
    })
  })
})

describe("the package graph", () => {
  it("reads every kind of dependency, an alias by what it installs", () => {
    const read = graphOf([
      { name: "a", devDependencies: { b: "workspace:*" }, peerDependencies: { c: "*" } },
      { name: "b", optionalDependencies: { alias: "workspace:c@*" } },
      { name: "c", dependencies: { zod: "4.0.0", c: "workspace:*" } },
    ])
    expect(Object.fromEntries(read)).toEqual({ a: ["b", "c"], b: ["c"], c: [] })
  })

  it("gives a package's dependencies, through any number of steps", () => {
    expect(dependencies(graph, "@novadeck/harness-claude")).toEqual([
      "@novadeck/harness-claude",
      "@novadeck/harness-core",
      "@novadeck/protocol",
      "@novadeck/terminal",
    ])
  })

  it("gives what a change affects: the packages changed and every dependent", () => {
    expect(affected(graph, ["@novadeck/core"])).toEqual([
      "@novadeck/core",
      "@novadeck/desktop",
      "@novadeck/specs",
      "@novadeck/ui",
    ])
  })
})
