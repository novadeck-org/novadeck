import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { hostless, ownHome } from "../testing/host.js"
import { installShellFiles } from "./install.js"

type Fixture = {
  readonly worktrees: string
  /** The person's Antigravity settings, in the shim's home. */
  readonly settings: string
  /** What the shim passes Antigravity as its own settings: `--settings` and Novadeck's file. */
  readonly allow: readonly string[]
  /** That file's settings. */
  readonly passed: () => unknown
  readonly bin: string
  readonly real: string
  /** The folder agy starts in unless a run names another: beside the worktrees', sorting before it. */
  readonly project: string
  readonly run: (args: string[], env?: NodeJS.ProcessEnv, path?: string[], cwd?: string) => string[]
}

// The shim as the runner writes it for Linux and macOS. The real agy is a stand-in that
// records the arguments it received.
const it = base.extend<{ shim: Fixture }>({
  shim: async ({ resources }, use) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-agy-posix-shim-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const worktrees = join(root, "worktrees")
    const paths = await installShellFiles(join(root, "shell"), {
      ...ownHome(root),
      worktrees,
      platform: "linux",
    })
    const home = join(root, "home")
    const settings = join(home, ".gemini", "antigravity-cli", "settings.json")
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true })
    const terminal = "00000000-0000-4000-8000-000000000001"
    const file = join(paths.allow, `${terminal}.json`)
    const real = join(root, "real")
    mkdirSync(real)
    const project = join(root, "project")
    mkdirSync(project)
    const log = join(root, "args.json")
    const recorder = join(root, "record.cjs")
    writeFileSync(
      recorder,
      `require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))`,
    )
    writeFileSync(join(real, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`, {
      mode: 0o755,
    })
    const run: Fixture["run"] = (args, env = {}, path = [paths.bin, real], cwd = project) => {
      rmSync(log, { force: true })
      const result = spawnSync(join(paths.bin, "agy"), args, {
        env: hostless({
          PATH: [...path, process.env.PATH].join(delimiter),
          HOME: home,
          NOVADECK_TERMINAL_ID: terminal,
          NOVADECK_SHIMS: "claude agy",
          ...env,
        }),
        encoding: "utf8",
        timeout: 30_000,
        cwd,
      })
      expect(result.stderr).toBe("")
      expect(result.status).toBe(0)
      if (!existsSync(log)) throw new Error("agy never ran")
      return JSON.parse(readFileSync(log, "utf8")) as string[]
    }
    await use({
      worktrees,
      settings,
      allow: ["--settings", file],
      passed: () => JSON.parse(readFileSync(file, "utf8")) as unknown,
      bin: paths.bin,
      real,
      project,
      run,
    })
  },
})

describe.skipIf(process.platform === "win32")("agy shim on Linux and macOS", () => {
  it("runs a session with Novadeck's tools allowed while the folder of agents' worktrees is missing", ({
    shim,
  }) => {
    expect(shim.run(["-i", "fix a b", "$x"])).toEqual([...shim.allow, "-i", "fix a b", "$x"])
    expect(shim.passed()).toEqual({ permissions: { allow: ["mcp(novadeck_novadeck/*)"] } })
  })

  it("passes the person's own allow rules on with Novadeck's, afresh at each launch, and writes none of theirs", ({
    shim,
  }) => {
    const theirs = JSON.stringify({
      permissions: { allow: ["command(ls)"], deny: ["command(rm)"] },
      trustedWorkspaces: ["/x"],
    })
    writeFileSync(shim.settings, theirs)
    expect(shim.run(["--conversation", "abc"])).toEqual([...shim.allow, "--conversation", "abc"])
    expect(shim.passed()).toEqual({
      permissions: { allow: ["command(ls)", "mcp(novadeck_novadeck/*)"] },
    })
    expect(readFileSync(shim.settings, "utf8")).toBe(theirs)
    // A rule they added since, at the next launch.
    writeFileSync(
      shim.settings,
      JSON.stringify({ permissions: { allow: ["command(ls)", "command(pwd)"] } }),
    )
    shim.run([])
    expect(shim.passed()).toEqual({
      permissions: { allow: ["command(ls)", "command(pwd)", "mcp(novadeck_novadeck/*)"] },
    })
  })

  it("passes no settings where the person's can't be read, so none of their rules is lost", ({
    shim,
  }) => {
    writeFileSync(shim.settings, "{ not json")
    expect(shim.run(["hi"])).toEqual(["hi"])
    // Nor without a home, where their settings aren't known.
    writeFileSync(shim.settings, "{}")
    expect(shim.run(["hi"], { HOME: "" })).toEqual(["hi"])
  })

  it("opens the folder to a session once it exists, passing every argument on", ({ shim }) => {
    mkdirSync(shim.worktrees)
    const add = `--add-dir=${shim.worktrees}`
    expect(shim.run([])).toEqual([add, ...shim.allow])
    expect(shim.run(["--model", "x", "fix a b", "", "$x"])).toEqual([
      add,
      ...shim.allow,
      "--model",
      "x",
      "fix a b",
      "",
      "$x",
    ])
    expect(shim.run(["--conversation", "abc"])).toEqual([
      add,
      ...shim.allow,
      "--conversation",
      "abc",
    ])
  })

  // Antigravity works in the first of its workspaces by path, byte for byte, and a folder sorts
  // before what it holds (e2e/probes/agy-worktrees-folder.e2e.ts).
  it("opens the folder only where it sorts after the folder agy starts in, never from inside it", ({
    shim,
  }) => {
    mkdirSync(shim.worktrees)
    const worktree = join(shim.worktrees, "project", "fix")
    mkdirSync(worktree, { recursive: true })
    const after = join(shim.worktrees, "..", "zz-project")
    mkdirSync(after)
    expect(shim.run([], {}, undefined, worktree)).toEqual([...shim.allow])
    expect(shim.run([], {}, undefined, shim.worktrees)).toEqual([...shim.allow])
    expect(shim.run([], {}, undefined, after)).toEqual([...shim.allow])
    expect(shim.run([], {}, undefined, shim.project)).toEqual([
      `--add-dir=${shim.worktrees}`,
      ...shim.allow,
    ])
    // Bytes, not the locale's order: "Xproject" sorts before "worktrees", as Antigravity sorts.
    const upper = join(shim.worktrees, "..", "Xproject")
    mkdirSync(upper)
    expect(shim.run([], {}, undefined, upper)).toEqual([
      `--add-dir=${shim.worktrees}`,
      ...shim.allow,
    ])
  })

  it("leaves agy's commands alone, and reads an option's value as a value", ({ shim }) => {
    mkdirSync(shim.worktrees)
    const add = `--add-dir=${shim.worktrees}`
    expect(shim.run(["mcp", "list"])).toEqual(["mcp", "list"])
    expect(shim.run(["--log-file", "f", "models"])).toEqual(["--log-file", "f", "models"])
    expect(shim.run(["--project", "models", "hi"])).toEqual([
      add,
      ...shim.allow,
      "--project",
      "models",
      "hi",
    ])
  })

  it("runs outside Novadeck's shells, and while Antigravity is not connected, unchanged", ({
    shim,
  }) => {
    mkdirSync(shim.worktrees)
    expect(shim.run(["hi"], { NOVADECK_TERMINAL_ID: "" })).toEqual(["hi"])
    expect(shim.run(["hi"], { NOVADECK_SHIMS: "claude" })).toEqual(["hi"])
  })

  it("passes over another Novadeck's shim on PATH, which would call this one back", async ({
    shim,
  }) => {
    const otherRoot = mkdtempSync(join(tmpdir(), "novadeck-other-"))
    const other = await installShellFiles(otherRoot, {
      ...ownHome(otherRoot),
      platform: "linux",
    })
    mkdirSync(shim.worktrees)
    expect(shim.run(["hi"], {}, [shim.bin, other.bin, shim.real])).toEqual([
      `--add-dir=${shim.worktrees}`,
      ...shim.allow,
      "hi",
    ])
  })
})
