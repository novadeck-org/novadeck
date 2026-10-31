import { describe, expect, it } from "vitest"

import { matchesCommand, refusesCommand } from "./commands.js"

const exact = (...argv: string[]) => ({ argv, rest: false })
const rest = (...argv: string[]) => ({ argv, rest: true })

describe("a command that can be granted", () => {
  it("is a bare program with words, exact or followed by anything", () => {
    expect(refusesCommand(exact("pwd"))).toBeUndefined()
    expect(refusesCommand(exact("git", "status"))).toBeUndefined()
    expect(refusesCommand(rest("uberepo", "ship"))).toBeUndefined()
    expect(refusesCommand(exact("gh", "pr", "view", "--body", "a\nb"))).toBeUndefined()
  })

  it.each([
    ["no words", exact()],
    ["a path", exact("./gh", "pr")],
    ["an absolute path", exact("/usr/bin/git", "status")],
    ["a non-ASCII word", exact("echo", "café")],
    ["a newline outside --body", exact("echo", "a\nb")],
    ["a shell", exact("bash")],
    ["env", exact("env", "git", "status")],
    ["sudo", exact("sudo", "ls")],
    ["python3", exact("python3")],
    ["Bash in capitals", exact("Bash")],
    ["NODE in capitals", exact("NODE")],
    ["python.exe", exact("python.exe", "x.py")],
    ["ENV in capitals", exact("ENV", "git", "status")],
    ["SUDO in capitals", exact("SUDO", "ls")],
    ["bash.cmd", exact("bash.cmd")],
    ["python3.12", exact("python3.12", "x.py")],
    ["node", exact("node")],
    ["pnpm, exact too", exact("pnpm", "test")],
    ["make", rest("make", "build")],
    ["docker", rest("docker", "ps")],
    ["rest on git", rest("git", "log")],
    ["rest on gh", rest("gh", "issue")],
    ["rest with one word", rest("uberepo")],
    ["rest with an option second", rest("uberepo", "--help")],
  ])("is not %s", (_name, command) => {
    expect(refusesCommand(command)).toEqual(expect.any(String))
  })

  it.each([
    "bash",
    "sh",
    "zsh",
    "env",
    "python",
    "node",
    "bun",
    "deno",
    "perl",
    "ruby",
    "npx",
    "npm",
    "pnpm",
    "yarn",
    "make",
    "cargo",
    "uv",
    "docker",
    "podman",
  ])("is never %s", (program) => {
    expect(refusesCommand(exact(program, "x"))).toEqual(expect.any(String))
    expect(refusesCommand(rest(program, "x"))).toEqual(expect.any(String))
  })
})

describe("matching a command", () => {
  it("needs every word of an exact command, no more", () => {
    expect(matchesCommand(exact("git", "status"), ["git", "status"])).toBe(true)
    expect(matchesCommand(exact("git", "status"), ["git", "status", "-s"])).toBe(false)
    expect(matchesCommand(exact("git", "status"), ["git"])).toBe(false)
    expect(matchesCommand(exact("git", "status"), ["/usr/bin/git", "status"])).toBe(false)
  })

  it("lets a rest command carry plain words after its own", () => {
    const grant = rest("uberepo", "ship")
    expect(matchesCommand(grant, ["uberepo", "ship", "--dry-run", "task/x", "a=b"])).toBe(true)
    expect(matchesCommand(grant, ["uberepo", "ship"])).toBe(false)
    expect(matchesCommand(grant, ["uberepo", "close", "x"])).toBe(false)
    expect(matchesCommand(grant, ["./uberepo", "ship", "x"])).toBe(false)
  })

  it("refuses a rest command's extra words that are not plain", () => {
    const grant = rest("uberepo", "ship")
    for (const word of ["a b", "x*", "$HOME", "a;b", "a\nb", "", "=x", "café", "'q'", "a|b"])
      expect(matchesCommand(grant, ["uberepo", "ship", word])).toBe(false)
  })

  it("never matches a command that could not be granted", () => {
    expect(matchesCommand(exact("python3"), ["python3"])).toBe(false)
    expect(matchesCommand(rest("git", "log"), ["git", "log", "-1"])).toBe(false)
  })

  it("grants a program only by its plain name, so GIT or git.exe can't slip past the git rules", () => {
    for (const program of ["GIT", "Gh", "git.exe", "gh.exe", "Uberepo", "uberepo.cmd"])
      expect(refusesCommand({ argv: [program, "push"], rest: true })).toMatch(/plain name/)
    expect(refusesCommand({ argv: ["uberepo", "ship"], rest: true })).toBeUndefined()
  })
})
