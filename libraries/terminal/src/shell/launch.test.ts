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
      {
        PATH: `/data/bin${delimiter}/usr/bin`,
        ACME_BIN: "/data/bin",
      },
    )
    const windows = launch("dash", {
      env: { Path: "C:\\bin" },
      pathFirst: "C:\\data\\bin",
    }).env
    expect(windows.Path).toBe(`C:\\data\\bin${delimiter}C:\\bin`)
    expect(windows).not.toHaveProperty("PATH")
    expect(launch("bash", { env: {}, pathFirst: "/data/bin" }).env.PATH).toBe("/data/bin")
    expect(launch("bash", { env: { PATH: "/usr/bin" } }).env).toEqual({
      PATH: "/usr/bin",
    })
  })

  it("holds a startup command for a Linux scope in the shells that read their cgroup", () => {
    const startup = { command: "make", file: "/data/resume/1" }
    const linux = {
      env: {},
      startup,
      scoped: true,
      platform: "linux",
    } as const
    for (const shell of ["bash", "zsh", "fish"]) {
      expect(launch(shell, linux).env.ACME_SCOPE).toBe("1")
      expect(launch(shell, linux)).not.toHaveProperty("scopeFile")
    }
    // Nothing to hold, nothing on its way, or a shell that doesn't wait.
    expect(launch("bash", { env: {}, scoped: true }).env).not.toHaveProperty("ACME_SCOPE")
    expect(launch("bash", { env: {}, startup }).env).not.toHaveProperty("ACME_SCOPE")
    expect(launch("pwsh", linux).env).not.toHaveProperty("ACME_SCOPE")
  })

  it("holds a startup command for a Windows job until the file made once it has settled", () => {
    const startup = { command: "make", file: "C:\\data\\resume\\1" }
    const windows = {
      env: {},
      startup,
      scoped: true,
      platform: "win32",
    } as const
    for (const shell of ["bash", "pwsh.exe", "powershell.exe"]) {
      const held = launch(shell, windows)
      expect(held.scopeFile).toBe("C:\\data\\resume\\1.held")
      expect(held.env.ACME_SCOPE).toBe(held.scopeFile)
    }
    // Nothing on its way: nothing to wait for.
    expect(launch("pwsh.exe", { ...windows, scoped: false })).not.toHaveProperty("scopeFile")
  })

  it("names the startup command's file, for every shell but cmd", () => {
    const startup = { command: "make", file: "/data/resume/1" }
    for (const shell of ["bash", "zsh", "fish", "pwsh"]) {
      const { env, resumes, resumeFile } = launch(shell, { env: {}, startup })
      expect(env.ACME_RESUME).toBe("/data/resume/1")
      expect({ resumes, resumeFile }).toEqual({
        resumes: true,
        resumeFile: "/data/resume/1",
      })
    }
    expect(launch("bash", { env: {} })).toMatchObject({
      resumes: false,
      resumeFile: undefined,
    })
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
    const startup = {
      command: 'git commit -m "fix it" && make',
      file: "C:\\data\\resume\\x",
    }
    const cmd = launch("C:\\Windows\\System32\\cmd.exe", { env: {}, startup })
    expect(cmd.args).toBe('/s /k "git commit -m "fix it" && make"')
    expect(cmd.resumes).toBe(true)
    expect(cmd.env).not.toHaveProperty("ACME_RESUME")
    expect(cmd).not.toHaveProperty("scopeFile")
  })

  it("holds the startup command for its job with the waiter, which has the file to wait for", () => {
    const startup = { command: "claude", file: "C:\\data\\resume\\x" }
    const waiter = "C:\\data\\novadeck-relay.exe"
    const windows = {
      env: {},
      startup,
      scoped: true,
      platform: "win32",
    } as const
    const cmd = launch("cmd.exe", { ...windows, waiter })
    expect(cmd.args).toBe(`/s /k ""${waiter}" held "C:\\data\\resume\\x.held" & claude"`)
    expect(cmd.scopeFile).toBe("C:\\data\\resume\\x.held")
    // Without a waiter it runs at once, and nothing waits for the file.
    expect(launch("cmd.exe", windows)).toMatchObject({
      args: '/s /k "claude"',
    })
    expect(launch("cmd.exe", windows)).not.toHaveProperty("scopeFile")
  })

  it("is started with nothing else without one", () => {
    expect(launch("cmd.exe", { env: {} }).args).toEqual([])
  })
})
