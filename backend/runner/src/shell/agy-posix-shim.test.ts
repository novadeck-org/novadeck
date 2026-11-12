import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { installShellFiles } from "./install.js"

type Fixture = {
  readonly worktrees: string
  readonly bin: string
  readonly real: string
  readonly run: (args: string[], env?: NodeJS.ProcessEnv, path?: string[]) => string[]
}

// The shim as the runner writes it for Linux and macOS. The real agy is a stand-in that
// records the arguments it received.
const it = base.extend<{ shim: Fixture }>({
  shim: async ({ resources }, use) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-agy-posix-shim-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const worktrees = join(root, "worktrees")
    const paths = await installShellFiles(join(root, "shell"), { worktrees, platform: "linux" })
    const real = join(root, "real")
    mkdirSync(real)
    const log = join(root, "args.json")
    const recorder = join(root, "record.cjs")
    writeFileSync(
      recorder,
      `require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))`,
    )
    writeFileSync(join(real, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`, {
      mode: 0o755,
    })
    const run: Fixture["run"] = (args, env = {}, path = [paths.bin, real]) => {
      rmSync(log, { force: true })
      const result = spawnSync(join(paths.bin, "agy"), args, {
        env: {
          ...process.env,
          PATH: [...path, process.env.PATH].join(delimiter),
          NOVADECK_TERMINAL_ID: "00000000-0000-4000-8000-000000000001",
          NOVADECK_SHIMS: "claude agy",
          ...env,
        },
        encoding: "utf8",
        timeout: 30_000,
      })
      expect(result.stderr).toBe("")
      expect(result.status).toBe(0)
      if (!existsSync(log)) throw new Error("agy never ran")
      return JSON.parse(readFileSync(log, "utf8")) as string[]
    }
    await use({ worktrees, bin: paths.bin, real, run })
  },
})

describe.skipIf(process.platform === "win32")("agy shim on Linux and macOS", () => {
  it("runs agy as it was given while the folder of agents' worktrees is missing", ({ shim }) => {
    expect(shim.run(["-i", "fix a b", "$x"])).toEqual(["-i", "fix a b", "$x"])
  })

  it("opens the folder to a session once it exists, passing every argument on", ({ shim }) => {
    mkdirSync(shim.worktrees)
    const add = `--add-dir=${shim.worktrees}`
    expect(shim.run([])).toEqual([add])
    expect(shim.run(["--model", "x", "fix a b", "", "$x"])).toEqual([
      add,
      "--model",
      "x",
      "fix a b",
      "",
      "$x",
    ])
    expect(shim.run(["--conversation", "abc"])).toEqual([add, "--conversation", "abc"])
  })

  it("leaves agy's commands alone, and reads an option's value as a value", ({ shim }) => {
    mkdirSync(shim.worktrees)
    const add = `--add-dir=${shim.worktrees}`
    expect(shim.run(["mcp", "list"])).toEqual(["mcp", "list"])
    expect(shim.run(["--log-file", "f", "models"])).toEqual(["--log-file", "f", "models"])
    expect(shim.run(["--project", "models", "hi"])).toEqual([add, "--project", "models", "hi"])
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
    const other = await installShellFiles(mkdtempSync(join(tmpdir(), "novadeck-other-")), {
      platform: "linux",
    })
    mkdirSync(shim.worktrees)
    expect(shim.run(["hi"], {}, [shim.bin, other.bin, shim.real])).toEqual([
      `--add-dir=${shim.worktrees}`,
      "hi",
    ])
  })
})
