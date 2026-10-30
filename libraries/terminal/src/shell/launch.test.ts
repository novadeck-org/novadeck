import { delimiter } from "node:path"

import { describe, expect, it } from "vitest"

import { shellLaunch, startsCommands } from "./launch.js"
import { fishQuote, psQuote } from "./quote.js"
import { shellScriptPaths } from "./scripts.js"

const scripts = shellScriptPaths("/data", "acme")
const launch = (
  shell: string,
  options: Omit<Parameters<typeof shellLaunch>[0], "shell" | "scripts">,
) => shellLaunch({ shell, scripts, ...options })

describe("a shell's launch", () => {
  it("loads each known shell's file after the person's own setup", () => {
    expect(launch("/bin/bash", { env: {} }).args).toEqual(["--init-file", scripts.bash])
    expect(launch("-zsh", { env: {} }).env.ZDOTDIR).toBe(scripts.zsh)
    expect(launch("fish", { env: {} }).args).toEqual([
      "--init-command",
      `source ${fishQuote(scripts.fish)}`,
    ])
    expect(launch("pwsh.exe", { env: {} }).args).toEqual([
      "-NoExit",
      "-Command",
      `try { . ${psQuote(scripts.powershell)} } catch {}`,
    ])
    for (const shell of ["bash", "zsh", "fish", "PowerShell.exe", "cmd.exe"])
      expect(launch(shell, { env: {} }).integrated).toBe(true)
  })

  it("keeps the person's ZDOTDIR for zsh under the prefix's name", () => {
    expect(launch("zsh", { env: { ZDOTDIR: "/mine" } }).env).toMatchObject({
      ZDOTDIR: scripts.zsh,
      ACME_ZDOTDIR: "/mine",
    })
    expect(launch("zsh", { env: {} }).env).not.toHaveProperty("ACME_ZDOTDIR")
  })

  it("puts `pathFirst` first on PATH, under the name the environment uses", () => {
    expect(launch("bash", { env: { PATH: "/usr/bin" }, pathFirst: "/data/bin" }).env).toMatchObject(
      { PATH: `/data/bin${delimiter}/usr/bin`, ACME_BIN: "/data/bin" },
    )
    const windows = launch("dash", { env: { Path: "C:\\bin" }, pathFirst: "C:\\data\\bin" }).env
    expect(windows.Path).toBe(`C:\\data\\bin${delimiter}C:\\bin`)
    expect(windows).not.toHaveProperty("PATH")
    expect(launch("bash", { env: {}, pathFirst: "/data/bin" }).env.PATH).toBe("/data/bin")
    expect(launch("bash", { env: { PATH: "/usr/bin" } }).env).toEqual({ PATH: "/usr/bin" })
  })

  it("names the startup command's file, for every shell but cmd", () => {
    const startup = { command: "make", file: "/data/resume/1" }
    for (const shell of ["bash", "zsh", "fish", "pwsh"]) {
      const { env, resumes, resumeFile } = launch(shell, { env: {}, startup })
      expect(env.ACME_RESUME).toBe("/data/resume/1")
      expect({ resumes, resumeFile }).toEqual({ resumes: true, resumeFile: "/data/resume/1" })
    }
    expect(launch("bash", { env: {} })).toMatchObject({ resumes: false, resumeFile: undefined })
  })

  it("starts other shells as they are", () => {
    const other = launch("/bin/dash", {
      env: { HOME: "/home/ada" },
      startup: { command: "make", file: "/f" },
    })
    expect(other).toEqual({
      args: [],
      env: { HOME: "/home/ada" },
      integrated: false,
      resumes: false,
    })
    expect(startsCommands("/bin/dash")).toBe(false)
    expect(startsCommands("C:\\Windows\\System32\\cmd.exe")).toBe(true)
  })
})

describe("cmd", () => {
  it("reports the directory ahead of the person's prompt", () => {
    expect(launch("cmd.exe", { env: { PROMPT: "$G" } }).env.PROMPT).toBe("$e]9;9;$P$e\\$G")
    expect(launch("cmd.exe", { env: {} }).env.PROMPT).toBe("$e]9;9;$P$e\\$P$G")
  })

  it("gets the startup command as one command line, inner quotes and all", () => {
    const startup = { command: 'git commit -m "fix it" && make', file: "C:\\data\\resume\\x" }
    const cmd = launch("C:\\Windows\\System32\\cmd.exe", { env: {}, startup })
    expect(cmd.args).toBe('/s /k "git commit -m "fix it" && make"')
    expect(cmd.resumes).toBe(true)
    expect(cmd.env).not.toHaveProperty("ACME_RESUME")
  })

  it("is started with nothing else without one", () => {
    expect(launch("cmd.exe", { env: {} }).args).toEqual([])
  })
})
