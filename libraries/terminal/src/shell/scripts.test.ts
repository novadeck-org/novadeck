import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

import { shellLaunch } from "./launch.js"
import { osc7Directory } from "./osc.js"
import { shellScriptPaths, shellScripts } from "./scripts.js"

const header = (comment: string, what: string) => `${comment} Acme ${what}.`

// One bash for the check and the run, which gets only the launch's PATH.
const bash = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout?.trim()

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

describe.skipIf(process.platform === "win32" || !bash)("bash's file", () => {
  it("runs the startup command once, keeps its folder first and reports the directory", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "terminal-shell-")))
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    const home = join(root, "home")
    const cwd = join(root, "My Dir ż")
    const first = join(root, "first")
    for (const directory of [home, cwd, first]) mkdirSync(directory)
    // The user's own startup file puts another folder first.
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
    // Back in front of what the user's file put first; the launch's own copy stays behind it.
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
