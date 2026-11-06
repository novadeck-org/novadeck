import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { claude } from "@novadeck/harness-claude/index"
import { gitBash } from "@novadeck/sandbox"

import { describe, expect, it as base } from "../test.js"
import { installShellFiles } from "./install.js"
import { pipedPrompt, quotedPrompts, splitPrompt } from "./shim-prompts.test-support.js"

const windows = process.platform === "win32"

type Fixture = {
  root: string
  run: (args: string[], env?: NodeJS.ProcessEnv, cwd?: string) => string[]
  launch: (
    program: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
    cwd?: string,
  ) => { result: SpawnSyncReturns<string>; received: string[] | undefined }
  bin: string
  real: string
  settings: string
  remove: () => void
  variables: () => unknown[]
}

// The real claude is a stand-in that records the arguments it received.
const it = base.extend<{ shim: Fixture }>({
  shim: async ({ resources }, use) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-claude-shim-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const paths = await installShellFiles(join(root, "shell"))
    const real = join(root, "real")
    mkdirSync(real)
    const log = join(root, "args.json")
    const variables = join(root, "variables.json")
    const recorder = join(root, "record.cjs")
    writeFileSync(
      recorder,
      `const { writeFileSync } = require("node:fs")
      writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))
      writeFileSync(${JSON.stringify(variables)}, JSON.stringify([process.env.novadeck_line, process.env.novadeck_arg]))`,
    )
    if (windows)
      writeFileSync(join(real, "claude.cmd"), `@"${process.execPath}" "${recorder}" %*\r\n`)
    else
      writeFileSync(
        join(real, "claude"),
        `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`,
        {
          mode: 0o755,
        },
      )
    const settings = join(paths.plugins.claude, "statusline.json")
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
        timeout: 30_000,
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
      const shim = join(paths.bin, windows ? "claude.cmd" : "claude")
      const { result, received } = launch(shim, args, env, cwd)
      if (result.status !== 0) throw new Error(`claude failed: ${result.stderr}`)
      // cmd only says so here when a shim's label is missing, and goes on.
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe("")
      if (received === undefined) throw new Error(`claude never ran: ${result.stderr}`)
      return received
    }
    await use({
      root,
      run,
      launch,
      bin: paths.bin,
      real,
      settings,
      remove: () => rmSync(settings),
      variables: () => JSON.parse(readFileSync(variables, "utf8")) as unknown[],
    })
  },
})

// Each test writes the shell files first, which on a cold Windows runner takes a while, as
// for Codex's shim.
describe("claude shim", { timeout: 60_000 }, () => {
  it("passes over another Novadeck's shim on PATH, as a runner started in a Novadeck terminal leaves", async ({
    shim,
  }) => {
    // Another Novadeck's shell files, whose shim would call this one back.
    const other = await installShellFiles(mkdtempSync(join(tmpdir(), "novadeck-other-")))
    const settings = expect.stringMatching(/statusline\.json$/)
    expect(
      shim.run(["hi"], {
        PATH: [shim.bin, other.bin, shim.real, process.env.PATH].join(delimiter),
      }),
    ).toEqual(["--settings", settings, "hi"])
  })

  it("runs a session with Novadeck's status line, passing every argument on", ({ shim }) => {
    const settings = expect.stringMatching(/plugins[/\\]claude[/\\]statusline\.json$/)
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

  it("names the status line Novadeck wrote", ({ shim }) => {
    expect(JSON.parse(readFileSync(shim.settings, "utf8"))).toEqual({
      statusLine: {
        type: "command",
        command: windows
          ? claude.hook("win32", "StatusLine")
          : '[ -n "$NOVADECK_HOOK" ] && "$NOVADECK_HOOK" claude StatusLine || true',
        padding: 0,
      },
    })
  })

  // Claude Code runs its status line in Git Bash on Windows. A batch file started there runs
  // through a cmd with no /d, which runs the AutoRun first; cmd says how it was started.
  it.runIf(windows)(
    "starts the status line's launcher in a cmd with /d, so no AutoRun prints ahead of it",
    ({ shim }) => {
      const bash = gitBash()
      expect(bash, "Git Bash").toBeDefined()
      const launcher = join(shim.root, "hook.cmd")
      writeFileSync(launcher, "@echo cmd=%CMDCMDLINE%\r\n@echo args=%*\r\n")
      const { statusLine } = JSON.parse(readFileSync(shim.settings, "utf8")) as {
        statusLine: { command: string }
      }
      const result = spawnSync(bash!, ["-c", statusLine.command], {
        env: { ...process.env, NOVADECK_HOOK: launcher },
        input: "{}",
        encoding: "utf8",
      })
      expect(result.stdout).toMatch(/^cmd=\S*cmd(?:\.exe)?"? \/d \/c /im)
      expect(result.stdout).toMatch(/^args=claude StatusLine\s*$/m)
    },
  )

  it("leaves Claude Code's other commands alone", ({ shim }) => {
    expect(shim.run(["mcp", "list"])).toEqual(["mcp", "list"])
    expect(shim.run(["--debug", "plugin", "install", "x"])).toEqual([
      "--debug",
      "plugin",
      "install",
      "x",
    ])
  })

  it("reads an option's value as a value, though it names one of Claude Code's commands", ({
    shim,
  }) => {
    const settings = expect.stringMatching(/statusline\.json$/)
    expect(shim.run(["-n", "update", "bump deps"])).toEqual([
      "--settings",
      settings,
      "-n",
      "update",
      "bump deps",
    ])
    expect(shim.run(["--agent", "agents", "--model", "haiku", "fix it"])).toEqual([
      "--settings",
      settings,
      "--agent",
      "agents",
      "--model",
      "haiku",
      "fix it",
    ])
    // A command after an option's value is still one.
    expect(shim.run(["--model", "haiku", "mcp", "list"])).toEqual([
      "--model",
      "haiku",
      "mcp",
      "list",
    ])
    expect(shim.run(["-n"])).toEqual(["--settings", settings, "-n"])
    // Its commands go by their case, as Claude Code's own reading does.
    expect(shim.run(["MCP"])).toEqual(["--settings", settings, "MCP"])
  })

  it("reads an option's list of values as values, up to the next option", ({ shim }) => {
    const settings = expect.stringMatching(/statusline\.json$/)
    for (const args of [
      ["--add-dir", "a", "mcp", "list"],
      ["--add-dir", "a", "b", "mcp"],
      ["--allowedTools", "Read", "update"],
      ["--tools", "Read", "-", "mcp"],
      ["--add-dir=a", "b", "mcp"],
      // Words cmd would run or change, were the shim's reading of the line to uncover them.
      ["--add-dir", "a & b", "mcp"],
      ["--add-dir", "a!b", "mcp"],
      // Nothing after it: the shim's reading of the line finds no value there.
      ["--add-dir"],
      // cmd splits a word at a comma too, into more of the list.
      ["--tools", "Read,Write", "mcp"],
      // Words cmd splits at a space it takes to be outside quotes, or holds a lone quote in.
      ["--add-dir", 'a "b c" d', "mcp"],
      ["--add-dir", 'he said "hi', "mcp"],
    ])
      expect(shim.run(args)).toEqual(["--settings", settings, ...args])
    // The next option ends it, so a command after that is still one.
    for (const args of [
      ["--add-dir", "a", "--verbose", "mcp", "list"],
      ["--add-dir", "a", "b", "--model", "haiku", "mcp", "list"],
      ["--add-dir", "a", "--", "mcp", "list"],
      // That form takes the one value, though cmd splits it from its option.
      ["--add-dir=a", "mcp", "list"],
      ["--mcp-config=a.json", "plugin", "list"],
      // An empty word is a value like any other, and the list goes on past it.
      ["--add-dir", "a", "", "--verbose", "mcp"],
      // cmd's delayed expansion would take these two for a variable, and the = form with them.
      ["--model", "a!b", "--add-dir=c", "mcp", "list", "d!e"],
      // An odd count of quotes after the command keeps it one.
      ["mcp", 'he said "hi'],
      ["--add-dir", 'say "hi there" now', "--verbose", "mcp", "list"],
    ])
      expect(shim.run(args)).toEqual(args)
  })

  it.for(quotedPrompts)("passes on whole the quoted prompt %j", (prompt, { shim }) => {
    expect(shim.run([prompt])).toEqual([
      "--settings",
      expect.stringMatching(/statusline\.json$/),
      prompt,
    ])
  })

  it("keeps the line it read, and a prompt, out of what claude and its tools inherit", ({
    shim,
  }) => {
    shim.run(["a secret prompt"])
    expect(shim.variables()).toEqual([null, null])
    shim.run(["--add-dir", "a", "--verbose", "a secret prompt"])
    expect(shim.variables()).toEqual([null, null])
  })

  // Help that printed would also page at a console, and wait there for a key.
  it("hands on a word that cmd's own commands take as a request for their help", ({ shim }) => {
    const settings = expect.stringMatching(/statusline\.json$/)
    for (const args of [["/?"], ["--add-dir", "a", "/?"], ["--verbose", "/?", "mcp"]])
      expect(shim.run(args)).toEqual(["--settings", settings, ...args])
  })

  it.runIf(windows)("takes a prompt cmd splits first as the real claude does alone", ({ shim }) => {
    const alone = shim.launch(join(shim.real, "claude.cmd"), [splitPrompt])
    const through = shim.launch(join(shim.bin, "claude.cmd"), [splitPrompt])
    expect(alone.received).toBeDefined()
    expect(through.received).toEqual([
      "--settings",
      expect.stringMatching(/statusline\.json$/),
      ...(alone.received ?? []),
    ])
    expect(through.result.status).toBe(alone.result.status)
    expect(through.result.stderr).toBe(alone.result.stderr)
  })

  it.runIf(windows)(
    "starts nothing at a pipe cmd splits first, as the real claude alone",
    ({ shim }) => {
      const alone = shim.launch(join(shim.real, "claude.cmd"), [pipedPrompt])
      const through = shim.launch(join(shim.bin, "claude.cmd"), [pipedPrompt])
      expect(alone.received).toBeUndefined()
      expect(through.received).toBeUndefined()
      expect(through.result.status).toBe(alone.result.status)
    },
  )

  it.runIf(windows)(
    "runs the real claude, never a claude.cmd in the current folder, where a plain where looks first",
    ({ shim }) => {
      const repo = join(shim.root, "repo")
      mkdirSync(repo)
      const marker = join(shim.root, "planted")
      writeFileSync(join(repo, "claude.cmd"), `@echo planted> "${marker}"\r\n`)
      expect(shim.run(["hi"], {}, repo)).toEqual([
        "--settings",
        expect.stringMatching(/statusline\.json$/),
        "hi",
      ])
      expect(existsSync(marker)).toBe(false)
    },
  )

  it("runs unchanged outside Novadeck's shells, or while Claude Code is not connected", ({
    shim,
  }) => {
    expect(shim.run(["hi"], { NOVADECK_TERMINAL_ID: "" })).toEqual(["hi"])
    expect(shim.run(["hi"], { NOVADECK_SHIMS: "codex" })).toEqual(["hi"])
    shim.remove()
    expect(shim.run(["hi"])).toEqual(["hi"])
  })
})
