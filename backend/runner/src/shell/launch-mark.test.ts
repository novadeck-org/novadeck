import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { launchOf, type Launch } from "@novadeck/terminal/shell"
import { spawn } from "node-pty"

import { describe, expect, it as base } from "../test.js"
import { hostless, ownHome } from "../testing/host.js"
import { installShellFiles } from "./install.js"

const windows = process.platform === "win32"
const terminalId = "00000000-0000-4000-8000-000000000001"

// Each shim tells Novadeck it starts its agent's session with a private OSC on the terminal
// (harnesses/core/src/launch-mark.ts), which the terminal's host reads (`launchOf`): run here
// in a real pty, through the ConPTY Novadeck ships on Windows, as the person's shell runs it.

type Fixture = {
  /**
   * What the shim for `program`, run with `args` in a pty, said it launched, and its output: on
   * POSIX, with no input, or with its stdout piped to `piped`.
   */
  readonly run: (
    program: "claude" | "codex" | "agy",
    args: readonly string[],
    env?: NodeJS.ProcessEnv,
    o?: { how?: "terminal" | "no input" | "piped" },
  ) => Promise<{ launches: Launch[]; output: string }>
  /** Where a piped run's stdout went. */
  readonly piped: string
}

// eslint-disable-next-line no-control-regex -- OSC 6973 reports, whole.
const reports = /\u001b\]6973;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g

// The real programs are stand-ins that say they ran.
const it = base.extend<{ shim: Fixture }>({
  shim: async ({ resources }, use) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-launch-mark-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const paths = await installShellFiles(join(root, "shell"), ownHome(root))
    const real = join(root, "real")
    mkdirSync(real)
    for (const program of ["claude", "codex", "agy"])
      if (windows) writeFileSync(join(real, `${program}.cmd`), `@echo ran ${program}\r\n`)
      else writeFileSync(join(real, program), `#!/bin/sh\necho ran ${program}\n`, { mode: 0o755 })
    await use({
      piped: join(root, "piped"),
      run: (program, args, env = {}, { how = "terminal" } = {}) =>
        new Promise((resolve, reject) => {
          const shim = join(paths.bin, windows ? `${program}.cmd` : program)
          // sh starts it reading from nowhere, or writing to a pipe, still on the pty.
          const through = { "no input": "</dev/null", piped: `| cat >"${join(root, "piped")}"` }
          const [file, command] = windows
            ? [process.env.COMSPEC ?? "cmd.exe", `/d /s /c ""${shim}" ${args.join(" ")}"`]
            : how === "terminal"
              ? [shim, [...args]]
              : ["/bin/sh", ["-c", `"$0" "$@" ${through[how]}`, shim, ...args]]
          const pty = spawn(file, command, {
            name: "xterm-256color",
            cols: 120,
            rows: 30,
            cwd: root,
            env: hostless({
              PATH: [paths.bin, real, process.env.PATH].join(delimiter),
              NOVADECK_TERMINAL_ID: terminalId,
              NOVADECK_SHIMS: "claude codex agy",
              ...env,
            }),
            useConptyDll: windows,
          })
          let output = ""
          pty.onData((data) => {
            output += data
          })
          const timer = setTimeout(() => {
            pty.kill()
            reject(new Error(`The ${program} shim never ended: ${JSON.stringify(output)}`))
          }, 30_000)
          pty.onExit(() => {
            clearTimeout(timer)
            const launches = [...output.matchAll(reports)].flatMap(([, data]) => {
              const launch = launchOf(data as string)
              return launch ? [launch] : []
            })
            resolve({ launches, output })
          })
        }),
    })
  },
})

// Installing the shell files first takes a while on a cold Windows runner, as in the other
// shim tests.
describe("launch marks", { timeout: 60_000 }, () => {
  for (const program of ["claude", "codex", "agy"] as const)
    it(`${program}'s shim says it launches a session, once, as the session starts`, async ({
      shim,
    }) => {
      const { launches, output } = await shim.run(program, ["hello"])
      expect(launches).toEqual([{ terminal: terminalId, program }])
      expect(output).toContain(`ran ${program}`)
    })

  it("says nothing for a harness's other commands", async ({ shim }) => {
    for (const [program, ...command] of [
      ["claude", "mcp"],
      ["claude", "--model", "opus", "mcp"],
      ["codex", "agents"],
      ["codex", "--remote"],
      ["agy", "plugin"],
      ["agy", "--model", "flash", "plugin"],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- One pty at a time.
      const { launches, output } = await shim.run(program, command)
      expect(launches, command.join(" ")).toEqual([])
      expect(output).toContain(`ran ${program}`)
    }
  })

  it("says it for a session whose option's value is named as a command", async ({ shim }) => {
    for (const program of ["claude", "agy"] as const) {
      // eslint-disable-next-line no-await-in-loop -- One pty at a time.
      const { launches } = await shim.run(program, ["--model", "plugin", "hello"])
      expect(launches, program).toEqual([{ terminal: terminalId, program }])
    }
  })

  it("says nothing for a harness that isn't connected, nor outside Novadeck's terminals", async ({
    shim,
  }) => {
    expect((await shim.run("claude", ["hello"], { NOVADECK_SHIMS: "codex" })).launches).toEqual([])
    expect((await shim.run("codex", ["hello"], { NOVADECK_TERMINAL_ID: "" })).launches).toEqual([])
  })

  it.skipIf(windows)(
    "says nothing where its input isn't a terminal, as in an agent's tool shell",
    async ({ shim }) => {
      const { launches, output } = await shim.run("codex", ["hello"], {}, { how: "no input" })
      expect(output).toContain("ran codex")
      expect(launches).toEqual([])
    },
  )

  it.skipIf(windows)(
    "says it on the terminal, never to a pipe reading the agent's output",
    async ({ shim }) => {
      const { launches } = await shim.run("claude", ["hello"], {}, { how: "piped" })
      expect(launches).toEqual([{ terminal: terminalId, program: "claude" }])
      expect(readFileSync(shim.piped, "utf8")).toBe("ran claude\n")
    },
  )
})
