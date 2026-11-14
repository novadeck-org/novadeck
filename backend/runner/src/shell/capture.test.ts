import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { captureFolder, prepareCaptureFolder } from "./capture.js"
import { installShellFiles } from "./install.js"

const windows = process.platform === "win32"
const has = (program: string) => spawnSync(program, ["-c", "exit 0"]).status === 0

// What a command Codex runs does with the capture its shim sets (see capture.ts): the shell
// it starts in loads the capture, which copies what it prints to a log while passing it on.
describe.skipIf(windows)("the capture of an agent's commands", { timeout: 30_000 }, () => {
  const setup = async (resources: { defer: (undo: () => void) => void }) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-capture-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const shell = await installShellFiles(join(root, "shell"), { worktrees: join(root, "w") })
    const folder = prepareCaptureFolder("terminal-1", root)!
    // As Codex starts a command: its shell, with the variables the shim has it set.
    const run = (program: string, script: string, env: NodeJS.ProcessEnv = {}) =>
      spawnSync(program, ["-c", script], {
        encoding: "utf8",
        timeout: 10_000,
        // As Codex starts its commands: input from nowhere. A bash whose input is a socket,
        // as Node's pipes are, takes itself for one ssh started, and reads .bashrc instead.
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: root,
          BASH_ENV: shell.capture.bashEnv,
          ZDOTDIR: shell.capture.zdotdir,
          NOVADECK_CAPTURE: folder,
          NOVADECK_USER_BASH_ENV: "",
          NOVADECK_USER_ZDOTDIR: "",
          ...env,
        },
      })
    const captured = () => {
      const names = readdirSync(folder)
      const logs = names.filter((name) => name.endsWith(".log"))
      return logs.map((log) => ({
        log: readFileSync(join(folder, log), "utf8"),
        command: readFileSync(join(folder, log.replace(/\.log$/, ".command")), "utf8"),
      }))
    }
    return { root, shell, folder, run, captured }
  }

  for (const program of ["bash", "zsh"])
    it.skipIf(!has(program))(
      `copies what a ${program} command prints to a log, passing it on unchanged`,
      async ({ resources }) => {
        const { run, captured } = await setup(resources)
        const result = run(program, "echo out; echo err >&2; exit 4")
        expect(result.status).toBe(4)
        expect(result.stdout).toBe("out\n")
        expect(result.stderr).toBe("err\n")
        const [only, ...more] = captured()
        expect(more).toEqual([])
        expect(only!.log.split("\n").toSorted()).toEqual(["", "err", "out"])
        expect(only!.command).toBe("echo out; echo err >&2; exit 4")
      },
    )

  for (const program of ["bash", "zsh"])
    it.skipIf(!has(program))(
      `lets a ${program} command wait for its own jobs, not the capture's`,
      async ({ resources }) => {
        const { run, captured } = await setup(resources)
        const result = run(program, "sleep 0.2 & wait; echo done; jobs")
        expect([result.status, result.stdout]).toEqual([0, "done\n"])
        expect(captured()[0]!.log).toBe("done\n")
      },
    )

  it("keeps what it captures the person's alone", async ({ resources }) => {
    const { folder, run } = await setup(resources)
    run("bash", "echo secret")
    for (const name of readdirSync(folder))
      expect(statSync(join(folder, name)).mode & 0o077, name).toBe(0)
  })

  it.skipIf(process.getuid === undefined)(
    "captures nowhere another account could read, or made first",
    ({ resources }) => {
      const root = mkdtempSync(join(tmpdir(), "novadeck-capture-"))
      resources.defer(() => rmSync(root, { recursive: true, force: true }))
      const parent = join(root, `novadeck-capture-${process.getuid!()}`)
      mkdirSync(parent, { mode: 0o755 })
      expect(prepareCaptureFolder("terminal-1", root)).toBeUndefined()
      expect(captureFolder("terminal-1", root, 4242)).toBe(
        join(root, "novadeck-capture-4242", "terminal-1"),
      )
    },
  )

  it("reads the person's BASH_ENV as bash would: expanded, and only where it names a file", async ({
    resources,
  }) => {
    const { root, run } = await setup(resources)
    writeFileSync(join(root, "own-env"), "echo own-env-loaded\n")
    const expanded = run("bash", "true", { NOVADECK_USER_BASH_ENV: "$HOME/own-env" })
    expect([expanded.stdout, expanded.stderr]).toEqual(["own-env-loaded\n", ""])
    const missing = run("bash", "echo hi", { NOVADECK_USER_BASH_ENV: join(root, "none") })
    expect([missing.status, missing.stdout, missing.stderr]).toEqual([0, "hi\n", ""])
  })

  it("captures nothing again in what the command starts, and gives it the person's BASH_ENV", async ({
    resources,
  }) => {
    const { root, run, captured } = await setup(resources)
    const own = join(root, "own-env")
    writeFileSync(own, "echo own-env-loaded\n")
    const result = run(
      "bash",
      `bash -c 'echo "inner \${NOVADECK_CAPTURE:-none} \${BASH_ENV:-none}"'`,
      { NOVADECK_USER_BASH_ENV: own },
    )
    expect(result.status).toBe(0)
    // The person's BASH_ENV runs for the command and again for the bash it starts, which
    // has no capture of its own.
    expect(result.stdout).toBe(`own-env-loaded\nown-env-loaded\ninner none ${own}\n`)
    expect(captured()).toHaveLength(1)
  })

  it.skipIf(!has("zsh"))(
    "gives a zsh command the person's own ZDOTDIR and .zshenv",
    async ({ resources }) => {
      const { root, run } = await setup(resources)
      const own = join(root, "zdot")
      rmSync(own, { recursive: true, force: true })
      spawnSync("mkdir", ["-p", own])
      writeFileSync(join(own, ".zshenv"), "echo own-zshenv\n")
      const result = run("zsh", 'echo "zdotdir=$ZDOTDIR"', { NOVADECK_USER_ZDOTDIR: own })
      expect(result.stdout).toBe(`own-zshenv\nzdotdir=${own}\n`)
    },
  )

  it("leaves a command alone where no folder is named, or it can't be made", async ({
    resources,
  }) => {
    const { root, run } = await setup(resources)
    const none = run("bash", "echo hi", { NOVADECK_CAPTURE: "" })
    expect([none.status, none.stdout, none.stderr]).toEqual([0, "hi\n", ""])
    const file = join(root, "a-file")
    writeFileSync(file, "")
    const blocked = run("bash", "echo hi", { NOVADECK_CAPTURE: join(file, "under") })
    expect([blocked.status, blocked.stdout, blocked.stderr]).toEqual([0, "hi\n", ""])
    const absent = run("bash", "echo hi", { NOVADECK_CAPTURE: join(root, "never-made") })
    expect([absent.status, absent.stdout, absent.stderr]).toEqual([0, "hi\n", ""])
  })
})
