import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { installShellFiles } from "./install.js"

type Fixture = {
  run: (args: string[], env?: NodeJS.ProcessEnv) => string[]
  bin: string
  real: string
  settings: string
  remove: () => void
}

// The real claude is a stand-in that records the arguments it received. NovaDeck gives
// Windows no Claude Code shim yet.
const it = base.extend<{ shim: Fixture }>({
  shim: async ({ resources }, use) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-claude-shim-"))
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
    writeFileSync(
      join(real, "claude"),
      `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`,
      {
        mode: 0o755,
      },
    )
    const settings = join(paths.plugins.claude, "statusline.json")
    const run: Fixture["run"] = (args, env = {}) => {
      rmSync(log, { force: true })
      const result = spawnSync(join(paths.bin, "claude"), args, {
        env: {
          ...process.env,
          PATH: [paths.bin, real, process.env.PATH].join(delimiter),
          NOVADECK_TERMINAL_ID: "00000000-0000-4000-8000-000000000001",
          NOVADECK_SHIMS: "claude codex",
          ...env,
        },
        encoding: "utf8",
      })
      if (result.status !== 0) throw new Error(`claude failed: ${result.stderr}`)
      return JSON.parse(readFileSync(log, "utf8")) as string[]
    }
    await use({ run, bin: paths.bin, real, settings, remove: () => rmSync(settings) })
  },
})

describe.skipIf(process.platform === "win32")("claude shim", () => {
  it("passes over another NovaDeck's shim on PATH, as a runner started in a NovaDeck terminal leaves", async ({
    shim,
  }) => {
    // Another NovaDeck's shell files, whose shim would call this one back.
    const other = await installShellFiles(mkdtempSync(join(tmpdir(), "novadeck-other-")))
    const settings = expect.stringMatching(/statusline\.json$/)
    expect(
      shim.run(["hi"], {
        PATH: [shim.bin, other.bin, shim.real, process.env.PATH].join(delimiter),
      }),
    ).toEqual(["--settings", settings, "hi"])
  })

  it("runs a session with NovaDeck's status line, passing every argument on", ({ shim }) => {
    const settings = expect.stringMatching(/plugins\/claude\/statusline\.json$/)
    expect(shim.run([])).toEqual(["--settings", settings])
    expect(shim.run(["--model", "haiku", "fix a b", "$x"])).toEqual([
      "--settings",
      settings,
      "--model",
      "haiku",
      "fix a b",
      "$x",
    ])
  })

  it("names the status line NovaDeck wrote", ({ shim }) => {
    expect(JSON.parse(readFileSync(shim.settings, "utf8"))).toEqual({
      statusLine: {
        type: "command",
        command: '[ -n "$NOVADECK_HOOK" ] && "$NOVADECK_HOOK" claude StatusLine || true',
        padding: 0,
      },
    })
  })

  it("leaves Claude Code's other commands alone", ({ shim }) => {
    expect(shim.run(["mcp", "list"])).toEqual(["mcp", "list"])
    expect(shim.run(["--debug", "plugin", "install", "x"])).toEqual([
      "--debug",
      "plugin",
      "install",
      "x",
    ])
  })

  it("runs unchanged outside NovaDeck's shells, or while Claude Code is not connected", ({
    shim,
  }) => {
    expect(shim.run(["hi"], { NOVADECK_TERMINAL_ID: "" })).toEqual(["hi"])
    expect(shim.run(["hi"], { NOVADECK_SHIMS: "codex" })).toEqual(["hi"])
    shim.remove()
    expect(shim.run(["hi"])).toEqual(["hi"])
  })
})
