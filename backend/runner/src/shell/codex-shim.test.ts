import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { installShellFiles } from "./install.js"
import { quotedPrompts, splitPrompts } from "./shim-prompts.test-support.js"

const windows = process.platform === "win32"

type Fixture = {
  readonly root: string
  readonly run: (args: string[], env?: NodeJS.ProcessEnv, cwd?: string) => string[]
  readonly launch: (
    program: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
    cwd?: string,
  ) => { result: SpawnSyncReturns<string>; received: string[] | undefined }
  readonly bin: string
  readonly real: string
}

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
    const launch: Fixture["launch"] = (program, args, env = {}, cwd) => {
      rmSync(log, { force: true })
      const options = {
        env: {
          ...process.env,
          PATH: [paths.bin, real, process.env.PATH].join(delimiter),
          NOVADECK_TERMINAL_ID: "00000000-0000-4000-8000-000000000001",
          NOVADECK_SHIMS: "claude codex",
          ...env,
        },
        encoding: "utf8" as const,
        ...(cwd !== undefined && { cwd }),
      }
      const result = windows
        ? spawnSync(process.env.COMSPEC ?? "cmd.exe", ["/d", "/c", program, ...args], options)
        : spawnSync(program, args, options)
      return {
        result,
        received: existsSync(log) ? (JSON.parse(readFileSync(log, "utf8")) as string[]) : undefined,
      }
    }
    const run: Fixture["run"] = (args, env = {}, cwd) => {
      const shim = join(paths.bin, windows ? "codex.cmd" : "codex")
      const { result, received } = launch(shim, args, env, cwd)
      if (result.status !== 0) throw new Error(`codex failed: ${result.stderr}`)
      // cmd only says so here when a shim's label is missing, and goes on.
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe("")
      if (received === undefined) throw new Error(`codex never ran: ${result.stderr}`)
      return received
    }
    await use({ root, run, launch, bin: paths.bin, real })
  },
})

// Each test writes the shell files first, which on a cold Windows runner, with cmd's AutoRun
// check and a fresh relay for the antivirus to scan, took most of 31 s the first time.
describe("codex shim", { timeout: 60_000 }, () => {
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

  it("reads each word of a line with quotes in it", ({ shim }) => {
    const title = ["-c", "tui.terminal_title=['status','thread-id']"]
    expect(shim.run(["", "agents"])).toEqual(["", "agents"])
    expect(shim.run(["agents", "/?"])).toEqual(["agents", "/?"])
    expect(shim.run(["agents", 'he said "hi'])).toEqual(["agents", 'he said "hi'])
    expect(shim.run(['say "hi there" now', "--remote", "x"])).toEqual([
      'say "hi there" now',
      "--remote",
      "x",
    ])
    expect(shim.run(["--no-daemon", 'he said "hi'])).toEqual([
      ...title,
      "--no-daemon",
      'he said "hi',
    ])
  })

  it.for(quotedPrompts)("passes on whole the quoted prompt %j", (prompt, { shim }) => {
    expect(shim.run([prompt])).toEqual([
      "--no-daemon",
      "-c",
      "tui.terminal_title=['status','thread-id']",
      prompt,
    ])
  })

  it("leaves codex alone while Codex is not connected", ({ shim }) => {
    // Another harness's shim put this folder on PATH.
    expect(shim.run(["exec", "hi"], { NOVADECK_SHIMS: "claude" })).toEqual(["exec", "hi"])
  })

  it("hands on a word that cmd's own commands take as a request for their help", ({ shim }) => {
    const { result, received } = shim.launch(join(shim.bin, windows ? "codex.cmd" : "codex"), [
      "/?",
    ])
    expect(result.status).toBe(0)
    expect(received).toEqual([
      "--no-daemon",
      "-c",
      "tui.terminal_title=['status','thread-id']",
      "/?",
    ])
  })

  it.runIf(windows).for(splitPrompts)(
    "takes the prompt %j, which cmd splits first, as the real codex does alone",
    (prompt, { shim }) => {
      const alone = shim.launch(join(shim.real, "codex.cmd"), [prompt])
      const through = shim.launch(join(shim.bin, "codex.cmd"), [prompt])
      expect(alone.received).toBeDefined()
      expect(through.received).toEqual([
        "--no-daemon",
        "-c",
        "tui.terminal_title=['status','thread-id']",
        ...(alone.received ?? []),
      ])
      expect(through.result.status).toBe(alone.result.status)
      expect(through.result.stderr).toBe(alone.result.stderr)
    },
  )

  it.runIf(windows)(
    "runs the real codex, never a codex.cmd in the current folder, where a plain where looks first",
    ({ shim }) => {
      const repo = join(shim.root, "repo")
      mkdirSync(repo)
      const marker = join(shim.root, "planted")
      writeFileSync(join(repo, "codex.cmd"), `@echo planted> "${marker}"\r\n`)
      expect(shim.run(["exec", "hi"], {}, repo)).toEqual([
        "--no-daemon",
        "-c",
        "tui.terminal_title=['status','thread-id']",
        "exec",
        "hi",
      ])
      expect(existsSync(marker)).toBe(false)
    },
  )
})
