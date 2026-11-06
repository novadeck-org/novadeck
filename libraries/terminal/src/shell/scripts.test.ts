import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

import { spawnPty } from "../pty/pty.js"
import { shellLaunch } from "./launch.js"
import { osc7Directory } from "./osc.js"
import { shellScriptPaths, shellScripts } from "./scripts.js"

const header = (comment: string, what: string) => `${comment} Acme ${what}.`

const onPath = (shell: string) =>
  spawnSync("sh", ["-c", `command -v ${shell}`], { encoding: "utf8" }).stdout?.trim()

// One bash for the check and the run, which gets only the launch's PATH.
const bash = onPath("bash")

describe("the shells' files", () => {
  it("are named after the prefix, with nothing of any other app's", () => {
    const files = shellScripts(shellScriptPaths("/data", "acme"), header)
    expect(files.map((file) => file.path)).toEqual([
      join("/data", "bash", "acme.bash"),
      join("/data", "zsh", ".zshenv"),
      join("/data", "zsh", ".zprofile"),
      join("/data", "zsh", ".zshrc"),
      join("/data", "fish", "acme.fish"),
      join("/data", "powershell", "acme.ps1"),
    ])
    for (const file of files) {
      expect(file.mode).toBe(0o600)
      expect(file.content).toMatch(/^# Acme shell integration for (bash|zsh|fish|PowerShell)\.\n/)
      expect(file.content).toMatch(/ACME_RESUME|ACME_ZDOTDIR/)
      expect(file.content).not.toMatch(/novadeck|codex|agent/i)
    }
  })

  it("wait for a scope before a startup command in bash, zsh and fish, and clear the word of it", () => {
    const scripts = shellScriptPaths("/data", "acme")
    const files = shellScripts(scripts, header)
    const named = (path: string) => files.find((file) => file.path === path)!.content
    for (const path of [scripts.bash, join("/data", "zsh", ".zshrc"), scripts.fish]) {
      const content = named(path)
      expect(content).toMatch(/__acme_scope.*ACME_SCOPE/)
      expect(content).toContain(".scope*")
      expect(content).toMatch(/(unset .*|set -e )ACME_SCOPE/)
      // Before the command is read, so removing its file while it waits still cancels it.
      expect(content.indexOf("while ")).toBeLessThan(content.indexOf("rm -f --"))
    }
    expect(named(scripts.powershell)).not.toContain("ACME_SCOPE")
  })

  it("refuse a prefix that isn't a plain lowercase name", () => {
    for (const prefix of ["", "Acme", "acme-app", "1acme", "a b"]) {
      expect(() => shellScriptPaths("/data", prefix)).toThrow("A shell prefix is lowercase")
      const scripts = { ...shellScriptPaths("/data", "acme"), prefix }
      expect(() => shellScripts(scripts, header)).toThrow("A shell prefix is lowercase")
      expect(() => shellLaunch({ shell: "bash", scripts, env: {} })).toThrow(
        "A shell prefix is lowercase",
      )
    }
  })
})

// The Linux job that runs these tests installs fish and sets this, so they can't skip there.
const fishRequired = process.env.NOVADECK_REQUIRE_FISH === "1"
const fish = spawnSync("sh", ["-c", "command -v fish"], { encoding: "utf8" }).stdout?.trim()

describe.skipIf(process.platform === "win32" || (!fish && !fishRequired))("fish's file", () => {
  it("runs the startup command with bracketed paste off, and goes on as a shell", async () => {
    expect(fish, "the job sets NOVADECK_REQUIRE_FISH, so it must install fish").toBeTruthy()
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "terminal-shell-")))
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    const home = join(root, "home")
    mkdirSync(home)
    const scripts = shellScriptPaths(join(root, "shell"), "acme")
    for (const file of shellScripts(scripts, header)) {
      mkdirSync(dirname(file.path), { recursive: true })
      writeFileSync(file.path, file.content, { mode: file.mode })
    }
    const startup = { command: 'echo "started "(math 40 + 2)', file: join(root, "startup") }
    writeFileSync(startup.file, startup.command)
    const launch = shellLaunch({
      shell: "fish",
      scripts,
      env: { HOME: home, PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" },
      startup,
    })

    const pty = spawnPty({
      file: fish!,
      args: launch.args,
      cwd: root,
      env: launch.env,
      cols: 80,
      rows: 24,
    })
    let output = ""
    let typed = false
    const exited = new Promise<number | null>((resolve) => {
      pty.onExit(({ code }) => resolve(code))
      pty.onData((data) => {
        output += data
        // The prompt reported after the command: the person can type now.
        const started = output.indexOf("started 42")
        if (!typed && started !== -1 && output.indexOf("\u001b]7;", started) !== -1) {
          typed = true
          pty.write("echo usable (math 6 '*' 7); exit\r")
        }
      })
    })
    let ended = false
    onTestFinished(() => {
      if (!ended && pty.pid) process.kill(pty.pid, "SIGKILL")
    })

    expect(await exited).toBe(0)
    ended = true
    const started = output.indexOf("started 42")
    expect(started).toBeGreaterThan(-1)
    expect(output.match(/started 42/g)).toHaveLength(1)
    expect(existsSync(startup.file)).toBe(false)
    // Off when the command ran, whatever fish had set before it, and back on after it.
    const off = output.lastIndexOf("\u001b[?2004l", started)
    expect(off).toBeGreaterThan(-1)
    expect(off).toBeGreaterThan(output.lastIndexOf("\u001b[?2004h", started))
    expect(output.indexOf("\u001b[?2004h", started)).toBeGreaterThan(started)
    // Still a shell.
    expect(output).toContain("usable 42")
  }, 30_000)
})

describe.skipIf(process.platform === "win32" || !bash)("bash's file", () => {
  it("runs the startup command once, keeps its folder first and reports the directory", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "terminal-shell-")))
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    const home = join(root, "home")
    const cwd = join(root, "My Dir ż")
    const first = join(root, "first")
    for (const directory of [home, cwd, first]) mkdirSync(directory)
    // The person's own startup file puts another folder first.
    writeFileSync(join(home, ".bashrc"), 'PATH="/elsewhere:$PATH"\n')
    const scripts = shellScriptPaths(join(root, "shell"), "acme")
    for (const file of shellScripts(scripts, header)) {
      mkdirSync(dirname(file.path), { recursive: true })
      writeFileSync(file.path, file.content, { mode: file.mode })
    }
    const startup = { command: 'echo "started $((40 + 2))"', file: join(root, "startup") }
    writeFileSync(startup.file, startup.command)

    const launch = shellLaunch({
      shell: "bash",
      scripts,
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      pathFirst: first,
      startup,
    })
    const run = spawnSync(bash ?? "bash", [...launch.args, "-i"], {
      cwd,
      env: launch.env,
      input: 'printf "path=%s\\n" "$PATH"\nprintf "resume=%s\\n" "${ACME_RESUME-unset}"\nexit\n',
      encoding: "utf8",
      timeout: 15_000,
    })

    expect(run.stdout).toContain("started 42\n")
    expect(run.stdout.match(/started/g)).toHaveLength(1)
    expect(existsSync(startup.file)).toBe(false)
    // Back in front of what the person's file put first; the launch's own copy stays behind it.
    expect(run.stdout).toContain(`path=${first}:/elsewhere:${first}:/usr/bin:/bin\n`)
    expect(run.stdout).toContain("resume=unset\n")
    const reports = run.stdout
      .split("\u001b]7;")
      .slice(1)
      .map((report) => report.split("\u001b\\")[0])
    expect(reports.length).toBeGreaterThan(0)
    for (const data of reports) expect(osc7Directory(data ?? "", hostname())).toBe(cwd)
  })
})

// Run for real wherever the shell is, on a terminal, as each draws a first prompt only there:
// /proc is what it reads, and nothing sets the variable on any other system.
describe.skipIf(process.platform !== "linux")("a scope that doesn't come", () => {
  for (const [name, path] of [
    ["bash", bash],
    ["zsh", onPath("zsh")],
    ["fish", onPath("fish")],
  ] as const)
    it.skipIf(!path)(`leaves ${name} running its startup command, with no word of it`, async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "terminal-shell-")))
      onTestFinished(() => rmSync(root, { recursive: true, force: true }))
      const home = join(root, "home")
      mkdirSync(home)
      const scripts = shellScriptPaths(join(root, "shell"), "acme")
      for (const file of shellScripts(scripts, header)) {
        mkdirSync(dirname(file.path), { recursive: true })
        writeFileSync(file.path, file.content, { mode: file.mode })
      }
      const out = join(root, "out")
      const startup = {
        command: `echo "scope=[$ACME_SCOPE]" > '${out}'; exit`,
        file: join(root, "startup"),
      }
      writeFileSync(startup.file, startup.command)
      const launch = shellLaunch({
        shell: name,
        scripts,
        env: { HOME: home, PATH: `${dirname(path!)}:/usr/bin:/bin`, TERM: "xterm-256color" },
        startup,
        scoped: true,
      })
      const began = performance.now()
      const pty = spawnPty({
        file: path!,
        args: launch.args,
        cwd: root,
        env: launch.env,
        cols: 80,
        rows: 24,
      })
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${name} never ended`)), 15_000)
        pty.onExit(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      expect(readFileSync(out, "utf8")).toBe("scope=[]\n")
      // This shell is in no scope of that name, so it waited its whole time, and no more.
      const waited = performance.now() - began
      expect(waited).toBeGreaterThanOrEqual(200)
      expect(waited).toBeLessThan(10_000)
    })
})
