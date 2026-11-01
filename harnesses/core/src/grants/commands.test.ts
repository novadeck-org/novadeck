import { describe, expect, it } from "vitest"

import { matchesCommand, refusesCommand } from "./commands.js"

const exact = (...argv: string[]) => ({ argv, rest: false })
const rest = (...argv: string[]) => ({ argv, rest: true })

const runners: [string, ReturnType<typeof exact>][] = [
  "wsl",
  "start",
  "saps",
  "call",
  "iex",
  "invoke-expression",
  "ii",
  "invoke-item",
  "cscript",
  "wscript",
  "mshta",
  "rundll32",
  "regsvr32",
  "powershell",
  "pwsh",
  "cmd",
  "conhost",
].map((program) => [program, exact(program, "x")])

describe("a command that can be granted", () => {
  it("is a bare program with exact words", () => {
    expect(refusesCommand(exact("pwd"))).toBeUndefined()
    expect(refusesCommand(exact("git", "status"))).toBeUndefined()
    expect(refusesCommand(exact("uberepo", "ship"))).toBeUndefined()
    expect(refusesCommand(exact("gh", "pr", "create", "--body", "a\nb"))).toBeUndefined()
  })

  it("names the reason for a read-only gh command", () => {
    expect(refusesCommand(exact("gh", "pr", "view"))).toBe("read-only: it needs no grant")
    expect(refusesCommand(exact("gh", "repo", "clone", "o/n"))).toBeUndefined()
    expect(refusesCommand(exact("gh", "issue", "create"))).toBeUndefined()
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
    ...runners,
    ["pnpm, exact too", exact("pnpm", "test")],
    ["make", exact("make", "build")],
    ["docker", exact("docker", "ps")],
    ["gh pr view", exact("gh", "pr", "view", "12")],
    ["gh pr checks", exact("gh", "pr", "checks")],
    ["gh pr list", exact("gh", "pr", "list")],
    ["gh pr diff", exact("gh", "pr", "diff", "12")],
    ["gh pr status", exact("gh", "pr", "status")],
    ["gh issue view", exact("gh", "issue", "view", "3")],
    ["gh issue list", exact("gh", "issue", "list")],
    ["gh issue status", exact("gh", "issue", "status")],
    ["gh repo view", exact("gh", "repo", "view", "o/n")],
    ["followed by anything, on any program", rest("uberepo", "ship")],
    ["rest on git", rest("git", "log")],
    ["rest on gh", rest("gh", "issue")],
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

  it("matches a stored rest command to nothing, not even its own words", () => {
    const grant = rest("uberepo", "ship")
    expect(matchesCommand(grant, ["uberepo", "ship"])).toBe(false)
    expect(matchesCommand(grant, ["uberepo", "ship", "--dry-run", "task/x"])).toBe(false)
  })

  it("refuses a rest command with a message that tells the agent to list exact commands", () => {
    expect(refusesCommand(rest("uberepo", "ship"))).toMatch(/exact words/)
  })

  it("never matches a command that could not be granted", () => {
    expect(matchesCommand(exact("python3"), ["python3"])).toBe(false)
    expect(matchesCommand(rest("git", "log"), ["git", "log", "-1"])).toBe(false)
  })

  it("grants a program only by its plain name, so GIT or git.exe can't slip past the git rules", () => {
    for (const program of ["GIT", "Gh", "git.exe", "gh.exe", "Uberepo", "uberepo.cmd"])
      expect(refusesCommand({ argv: [program, "push"], rest: false })).toMatch(/plain name/)
    expect(refusesCommand({ argv: ["uberepo", "ship"], rest: false })).toBeUndefined()
  })
})
