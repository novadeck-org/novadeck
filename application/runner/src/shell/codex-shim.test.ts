import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { installShellFiles } from "./install.js"

const windows = process.platform === "win32"

type Fixture = { run: (args: string[], env?: NodeJS.ProcessEnv) => string[] }

// The real codex is a stand-in that records the arguments it received.
const it = base.extend<{ shim: Fixture }>({
  shim: async ({ resources }, use) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-codex-shim-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const paths = await installShellFiles(join(root, "shell"))
    const real = join(root, "real")
    mkdirSync(real)
    const log = join(root, "args.json")
    const recorder = join(root, "record.cjs")
    writeFileSync(
      recorder,
      `require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))`,
    )
    if (windows)
      writeFileSync(join(real, "codex.cmd"), `@"${process.execPath}" "${recorder}" %*\r\n`)
    else
      writeFileSync(
        join(real, "codex"),
        `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`,
        {
          mode: 0o755,
        },
      )
    const run: Fixture["run"] = (args, env = {}) => {
      rmSync(log, { force: true })
      const shim = join(paths.bin, windows ? "codex.cmd" : "codex")
      const options = {
        env: {
          ...process.env,
          PATH: [paths.bin, real, process.env.PATH].join(delimiter),
          NOVADECK_TERMINAL_ID: "00000000-0000-4000-8000-000000000001",
          NOVADECK_SHIMS: "claude codex",
          ...env,
        },
        encoding: "utf8" as const,
      }
      const result = windows
        ? spawnSync(process.env.COMSPEC ?? "cmd.exe", ["/d", "/c", shim, ...args], options)
        : spawnSync(shim, args, options)
      if (result.status !== 0) throw new Error(`codex failed: ${result.stderr}`)
      return JSON.parse(readFileSync(log, "utf8")) as string[]
    }
    await use({ run })
  },
})

describe("codex shim", () => {
  it("runs the real codex without its shared server, its title telling its state, passing every argument on", ({
    shim,
  }) => {
    const args = windows ? ["resume", "abc", "two words"] : ["resume", "abc", "a b", "", "$x"]
    const ours = ["--no-daemon", "-c", "tui.terminal_title=['status','thread-id']"]
    expect(shim.run(args)).toEqual([...ours, ...args])
    expect(shim.run([])).toEqual(ours)
  })

  it("leaves alone what needs the shared server, and runs outside Novadeck's shells", ({
    shim,
  }) => {
    expect(shim.run(["agents"])).toEqual(["agents"])
    expect(shim.run(["--remote", "ws://host"])).toEqual(["--remote", "ws://host"])
    // Already without the shared server: only the title is added.
    expect(shim.run(["--no-daemon"])).toEqual([
      "-c",
      "tui.terminal_title=['status','thread-id']",
      "--no-daemon",
    ])
    expect(shim.run(["exec", "hi"], { NOVADECK_TERMINAL_ID: "" })).toEqual(["exec", "hi"])
  })

  it("leaves codex alone while Codex is not connected", ({ shim }) => {
    // Another harness's shim put this folder on PATH.
    expect(shim.run(["exec", "hi"], { NOVADECK_SHIMS: "claude" })).toEqual(["exec", "hi"])
  })
})
