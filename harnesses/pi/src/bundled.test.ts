import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  bundledLauncher,
  cmdLauncher,
  posixLauncher,
  powershellTools,
  type BundledPi,
} from "./bundled.js"

const run = promisify(execFile)

// What the runner says while Novadeck's pi is switched off (backend/runner's harnesses/bundled-pi.ts).
const turnOn = "Turn on Novadeck Agent in Preferences > Experimental."

// The fake pi prints its words, one a line, then what its environment says of Novadeck's pi.
const fakePi = (platform: NodeJS.Platform): string =>
  platform === "win32"
    ? '@echo off\r\necho raw=%*\r\n:next\r\nif "%~1"=="" goto env\r\necho %~1\r\nshift\r\ngoto next\r\n:env\r\necho dir=%PI_CODING_AGENT_DIR%\r\necho mark=%NOVADECK_PI%\r\necho check=%PI_SKIP_VERSION_CHECK%\r\n'
    : '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\necho "dir=$PI_CODING_AGENT_DIR"\necho "mark=$NOVADECK_PI"\necho "check=$PI_SKIP_VERSION_CHECK"\n'

// `env` laid over `base` as Windows reads names, without case: its own `Path` would otherwise
// stand beside a given `PATH`, and the child take either.
const over = (base: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const given = new Set(Object.keys(env).map((name) => name.toUpperCase()))
  return {
    ...Object.fromEntries(Object.entries(base).filter(([name]) => !given.has(name.toUpperCase()))),
    ...env,
  }
}

describe("Novadeck's pi launcher", () => {
  let root: string
  let pi: BundledPi
  let launcher: string
  const windows = process.platform === "win32"

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-bundled-"))
    const program = join(root, "data", "bundled", "pi", "1.6.0-abc", windows ? "pi.cmd" : "pi")
    // A relay that answers as the runner does: refused where the folder `off` exists (switched
    // off), at once where the program is in place, else a fetch that puts it there, saying so on
    // stderr, or fails where the folder `offline` exists.
    const relay = join(root, windows ? "relay.cmd" : "relay")
    const folder = join(program, "..")
    await writeFile(
      relay,
      windows
        ? `@echo off\r\nif exist "${join(root, "off")}" (echo Novadeck couldn't get pi: ${turnOn.replace(">", "^>")} 1>&2 & exit /b 1)\r\nif exist "${program}" exit /b 0\r\nif exist "${join(root, "offline")}" (echo Novadeck couldn't get pi: offline 1>&2 & exit /b 1)\r\necho fetching %2 1>&2\r\nmkdir "${folder}"\r\ncopy /y "${join(root, "fake.cmd")}" "${program}" >nul\r\n`
        : `#!/bin/sh\n[ -d '${join(root, "off")}' ] && { echo "Novadeck couldn't get pi: ${turnOn}" >&2; exit 1; }\n[ -x '${program}' ] && exit 0\n[ -d '${join(root, "offline")}' ] && { echo "Novadeck couldn't get pi: offline" >&2; exit 1; }\necho "fetching $2" >&2\nmkdir -p '${folder}'\ncp '${join(root, "fake")}' '${program}'\nchmod 755 '${program}'\n`,
      { mode: 0o755 },
    )
    await writeFile(join(root, windows ? "fake.cmd" : "fake"), fakePi(process.platform), {
      mode: 0o755,
    })
    const extension = join(root, "shell", "plugins", "pi", "novadeck.mjs")
    await mkdir(join(extension, ".."), { recursive: true })
    await writeFile(extension, "export default () => {}\n")
    pi = { program, home: join(root, "data", "bundled", "pi", "agent"), relay, extension }
    const file = bundledLauncher(process.platform, pi)
    launcher = join(root, "shell", "bundled", file.path)
    await mkdir(join(launcher, ".."), { recursive: true })
    await writeFile(launcher, windows ? file.content.replaceAll("\n", "\r\n") : file.content, {
      mode: file.mode ?? 0o644,
    })
  })

  afterEach(() => rm(root, { recursive: true, force: true }))

  const launch = (args: readonly string[], env: NodeJS.ProcessEnv = {}) =>
    windows
      ? // cmd by its full path: a test's own PATH may not hold it.
        run(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", launcher, ...args], {
          env: { ...over(process.env, env), NOVADECK_TERMINAL_ID: "t1" },
        })
      : run(launcher, args, {
          env: { PATH: "/usr/bin:/bin", NOVADECK_TERMINAL_ID: "t1", ...env },
        })

  const lines = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

  it("fetches pi where it isn't in place, then starts it on its own agent folder", async () => {
    const { stdout, stderr } = await launch(["--model", "p/m", "fix it"])

    expect(stderr).toContain("fetching pi")
    const said = lines(stdout)
    // Windows' own launcher adds pi's powershell tools where it finds no bash; tested below.
    const words = said.filter((line) => !line.includes("="))
    expect(words.slice(0, 2)).toEqual(["-e", pi.extension])
    expect(words.slice(-3)).toEqual(["--model", "p/m", "fix it"])
    expect(said).toContain(`dir=${pi.home}`)
    expect(said).toContain("mark=bundled")
    expect(said).toContain("check=1")
  })

  it("starts pi in place without fetching it again", async () => {
    await launch([])
    await mkdir(join(root, "offline"))

    const { stderr } = await launch(["again"])

    expect(stderr).not.toContain("fetching")
  })

  it("stops with the fetch's reason, and starts nothing, where pi can't be fetched", async () => {
    await mkdir(join(root, "offline"))

    const failed = await launch([]).then(
      () => undefined,
      (error: { code?: number; stdout?: string; stderr?: string }) => error,
    )

    expect(failed?.code).toBe(1)
    expect(failed?.stderr).toContain("Novadeck couldn't get pi: offline")
    expect(lines(failed?.stdout ?? "")).toEqual([])
  })

  it("starts nothing while Novadeck's pi is switched off, though it is in place", async () => {
    await launch([])
    await mkdir(join(root, "off"))

    const failed = await launch(["go"]).then(
      () => undefined,
      (error: { code?: number; stdout?: string; stderr?: string }) => error,
    )

    expect(failed?.code).toBe(1)
    expect(failed?.stderr).toContain(`Novadeck couldn't get pi: ${turnOn}`)
    expect(lines(failed?.stdout ?? "")).toEqual([])
  })

  it.runIf(windows)("gives pi its powershell tools only where it finds no bash", async () => {
    const empty = join(root, "nowhere")
    await mkdir(empty)
    // Nowhere pi looks holds a bash: Program Files, then (x86), then PATH, which here holds
    // `where` alone (System32 may hold WSL's bash.exe, which pi would take, as the launcher does).
    const tools = join(root, "tools")
    await mkdir(tools)
    await copyFile(`${process.env.SystemRoot}\\System32\\where.exe`, join(tools, "where.exe"))
    const none = { ProgramFiles: empty, "ProgramFiles(x86)": empty, PATH: tools }
    // Its command line as cmd gives it: a .cmd file splits its words at a comma too, pi.exe
    // doesn't.
    // Its blanks run together: an empty %novadeck_tools% leaves two.
    const raw = (out: string) =>
      lines(out)
        .find((line) => line.startsWith("raw="))
        ?.replaceAll(/\s+/g, " ")
    const without = raw((await launch(["go"], none)).stdout)
    expect(without?.endsWith(`novadeck.mjs" ${powershellTools.join(" ")} go`)).toBe(true)
    // Git Bash where Git for Windows puts it.
    const git = join(root, "git")
    await mkdir(join(git, "Git", "bin"), { recursive: true })
    await writeFile(join(git, "Git", "bin", "bash.exe"), "")
    const withGit = raw((await launch(["go"], { ...none, ProgramFiles: git })).stdout)
    expect(withGit?.endsWith(`novadeck.mjs" go`)).toBe(true)
    // Any bash.exe on PATH, as pi takes one.
    await writeFile(join(tools, "bash.exe"), "")
    const onPath = raw((await launch(["go"], none)).stdout)
    expect(onPath?.endsWith(`novadeck.mjs" go`)).toBe(true)
  })
})

describe("Novadeck's pi launcher's text", () => {
  const pi: BundledPi = {
    program: "/data/bundled/pi/1.6.0-abc/pi/pi",
    home: "/data/bundled/pi/agent",
    relay: "/data/shell/novadeck-relay",
    extension: "/data/shell/plugins/pi/novadeck.mjs",
  }

  it("names its paths quoted for sh, and is executable", () => {
    const file = bundledLauncher("linux", { ...pi, home: "/home/o'neil/agent" })
    expect(file).toMatchObject({ path: "pi", mode: 0o700 })
    expect(file.content).toContain(`PI_CODING_AGENT_DIR='/home/o'\\''neil/agent'`)
    // It asks the runner each time, which refuses while switched off.
    expect(posixLauncher(pi)).toContain(`\n'/data/shell/novadeck-relay' fetch pi || exit 1\n`)
  })

  it("on Windows looks for bash where pi does before giving it powershell", () => {
    const cmd = cmdLauncher(pi)
    expect(bundledLauncher("win32", pi)).toEqual({ path: "pi.cmd", content: cmd })
    const order = [
      `if exist "%ProgramFiles%\\Git\\bin\\bash.exe" goto tools`,
      `if exist "%ProgramFiles(x86)%\\Git\\bin\\bash.exe" goto tools`,
      "where $PATH:bash.exe >nul 2>nul && goto tools",
      `set "novadeck_tools=--tools -bash,+powershell"`,
    ].map((line) => cmd.indexOf(line))
    expect(order.every((at) => at > 0)).toBe(true)
    expect(order).toEqual(order.toSorted((a, b) => a - b))
    // No block holds a path: "(x86)" would end one.
    expect(cmd).not.toMatch(/\(\s*\r?\n/)
  })

  it("reads no variable in a Windows path that holds a %", () => {
    const cmd = cmdLauncher({
      ...pi,
      program: "C:\\Users\\a%b%\\pi.exe",
      relay: "C:\\Users\\a%b%\\relay.exe",
    })
    expect(cmd).toContain(`set "novadeck_program=C:\\Users\\a%%b%%\\pi.exe"`)
    // `call` reads its line twice.
    expect(cmd).toContain(`call "C:\\Users\\a%%%%b%%%%\\relay.exe" fetch pi`)
  })
})
