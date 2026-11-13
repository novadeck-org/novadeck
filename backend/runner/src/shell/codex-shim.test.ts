import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, it as base } from "../test.js"
import { installShellFiles } from "./install.js"
import { pipedPrompt, quotedPrompts, splitPrompt } from "./shim-prompts.test-support.js"

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
  readonly worktrees: string
  readonly real: string
  /** The PATH the real codex was last given. */
  readonly path: () => string
  readonly pwshDir: string | undefined
}

// The real codex is a stand-in that records the arguments it received, and the PATH it was
// given. With `pwsh`, Novadeck's PowerShell pass-through is installed, as while Codex is
// connected on Windows, and the shim puts its folder first on PATH for codex.
const shimTest = (pwsh: boolean) =>
  base.extend<{ shim: Fixture }>({
    shim: async ({ resources }, use) => {
      const root = mkdtempSync(join(tmpdir(), "novadeck-codex-shim-"))
      resources.defer(() => rmSync(root, { recursive: true, force: true }))
      const worktrees = join(root, "worktrees")
      const pwshShim = join(root, "novadeck-pwsh.exe")
      writeFileSync(pwshShim, "pwsh")
      const paths = await installShellFiles(join(root, "shell"), { worktrees, pwshShim, pwsh })
      const real = join(root, "real")
      mkdirSync(real)
      const log = join(root, "args.json")
      const pathLog = join(root, "path.txt")
      const recorder = join(root, "record.cjs")
      writeFileSync(
        recorder,
        `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))); fs.writeFileSync(${JSON.stringify(pathLog)}, process.env.PATH ?? process.env.Path ?? "")`,
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
          timeout: 30_000,
          ...(cwd !== undefined && { cwd }),
        }
        const result = windows
          ? spawnSync(process.env.COMSPEC ?? "cmd.exe", ["/d", "/c", program, ...args], options)
          : spawnSync(program, args, options)
        return {
          result,
          received: existsSync(log)
            ? (JSON.parse(readFileSync(log, "utf8")) as string[])
            : undefined,
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
      const path = () => readFileSync(pathLog, "utf8")
      await use({
        root,
        run,
        launch,
        bin: paths.bin,
        real,
        worktrees,
        path,
        pwshDir: paths.pwshShimDir,
      })
    },
  })

// Each test writes the shell files first, which on a cold Windows runner, with cmd's AutoRun
// check and a fresh relay for the antivirus to scan, took most of 31 s the first time.
for (const pwsh of [false, true])
  describe(`codex shim${pwsh ? ", with Novadeck's PowerShell" : ""}`, { timeout: 60_000 }, () => {
    const it = shimTest(pwsh)

    it.runIf(windows && pwsh)(
      "gives a real codex.cmd Novadeck's PowerShell first on PATH, as a session and with the title alone",
      ({ shim }) => {
        expect(shim.pwshDir).toBeDefined()
        for (const args of [["exec", "hi"], ["--no-daemon"]]) {
          shim.run(args)
          expect(shim.path().split(delimiter)[0]).toBe(shim.pwshDir)
        }
        // Not where it runs as it would without Novadeck.
        shim.run(["agents"])
        expect(shim.path().split(delimiter)).not.toContain(shim.pwshDir)
      },
    )

    it("runs the real codex without its shared server, its title telling its state, passing every argument on", ({
      shim,
    }) => {
      const args = windows ? ["resume", "abc", "two words"] : ["resume", "abc", "a b", "", "$x"]
      const ours = ["--no-daemon", "-c", "tui.terminal_title=['status','thread-id']"]
      expect(shim.run(args)).toEqual([...ours, ...args])
      expect(shim.run([])).toEqual(ours)
    })

    it("opens the folder of agents' worktrees to a session once it exists, before any command", ({
      shim,
    }) => {
      const title = "tui.terminal_title=['status','thread-id']"
      expect(shim.run(["exec", "hi"])).toEqual(["--no-daemon", "-c", title, "exec", "hi"])
      mkdirSync(shim.worktrees)
      const add = `--add-dir=${shim.worktrees}`
      expect(shim.run([])).toEqual(["--no-daemon", add, "-c", title])
      expect(shim.run(["resume", "abc"])).toEqual([
        "--no-daemon",
        add,
        "-c",
        title,
        "resume",
        "abc",
      ])
      expect(shim.run(["exec", "hi"])).toEqual(["--no-daemon", add, "-c", title, "exec", "hi"])
      expect(shim.run(["--no-daemon"])).toEqual([add, "-c", title, "--no-daemon"])
      // What needs the shared server stays as it was.
      expect(shim.run(["agents"])).toEqual(["agents"])
      expect(shim.run(["--remote", "ws://host"])).toEqual(["--remote", "ws://host"])
      expect(shim.run(["exec", "hi"], { NOVADECK_TERMINAL_ID: "" })).toEqual(["exec", "hi"])
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

    it.skipIf(windows)(
      "has Codex's commands capture into the terminal's folder, the person's own BASH_ENV and ZDOTDIR passed on",
      async ({ shim }) => {
        // Paths with a blank and a quote in them stay one word each.
        const shell = await installShellFiles(join(shim.root, "it's shell"), {
          worktrees: shim.worktrees,
        })
        const env = { NOVADECK_CAPTURE: "/tmp/cap dir", BASH_ENV: "/home/u/my env", ZDOTDIR: "" }
        const set = (name: string, value: string) => `shell_environment_policy.set.${name}=${value}`
        const { received } = shim.launch(join(shell.bin, "codex"), ["exec", "hi"], env)
        expect(received).toEqual([
          "--no-daemon",
          "-c",
          "tui.terminal_title=['status','thread-id']",
          "-c",
          set("BASH_ENV", shell.capture.bashEnv),
          "-c",
          set("ZDOTDIR", shell.capture.zdotdir),
          "-c",
          set("NOVADECK_CAPTURE", "/tmp/cap dir"),
          "-c",
          set("NOVADECK_USER_BASH_ENV", "/home/u/my env"),
          "-c",
          set("NOVADECK_USER_ZDOTDIR", ""),
          "exec",
          "hi",
        ])
        // Not where the person's Codex sets its commands' environment itself.
        const home = join(shim.root, "codex-home")
        mkdirSync(home)
        writeFileSync(join(home, "config.toml"), '[shell_environment_policy]\ninherit = "core"\n')
        const own = shim.launch(join(shell.bin, "codex"), ["exec", "hi"], {
          ...env,
          CODEX_HOME: home,
        })
        expect(own.received).toEqual([
          "--no-daemon",
          "-c",
          "tui.terminal_title=['status','thread-id']",
          "exec",
          "hi",
        ])
      },
    )

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

    // Help that printed would also page at a console, and wait there for a key.
    it("hands on a word that cmd's own commands take as a request for their help", ({ shim }) => {
      expect(shim.run(["/?"])).toEqual([
        "--no-daemon",
        "-c",
        "tui.terminal_title=['status','thread-id']",
        "/?",
      ])
    })

    it.runIf(windows)(
      "takes a prompt cmd splits first as the real codex does alone",
      ({ shim }) => {
        const alone = shim.launch(join(shim.real, "codex.cmd"), [splitPrompt])
        const through = shim.launch(join(shim.bin, "codex.cmd"), [splitPrompt])
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
      "starts nothing at a pipe cmd splits first, as the real codex alone",
      ({ shim }) => {
        const alone = shim.launch(join(shim.real, "codex.cmd"), [pipedPrompt])
        const through = shim.launch(join(shim.bin, "codex.cmd"), [pipedPrompt])
        expect(alone.received).toBeUndefined()
        expect(through.received).toBeUndefined()
        expect(through.result.status).toBe(alone.result.status)
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
