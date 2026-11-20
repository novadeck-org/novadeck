import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { doorbellNonce, startLine } from "@novadeck/harness-core/prompts"

import { describe, expect, it } from "../test.js"
import { commandLine, commandWords } from "./commands.js"

// A task's start prompt is the doorbell tag in the command that starts the agent, which the
// person's own shell runs: it has to reach the agent as the one argument it is, in every shell
// Novadeck quotes for. The shells present here run it for real (POSIX ones on Linux and macOS,
// cmd and PowerShell on Windows, so CI there runs them).

const line = startLine("Ab12Cd")
const command = commandLine(["agent", line])

describe("a task's start prompt in a command line", () => {
  it("is one double-quoted word, which a POSIX shell's splitting gives back whole", () => {
    expect(command).toBe(`agent "${line}"`)
    expect(commandWords(command, "linux")).toEqual(["agent", line])
    expect(commandWords(command, "win32")).toEqual(["agent", line])
    expect(doorbellNonce(line)).toBe("Ab12Cd")
  })

  it("holds no character a shell expands or ends a double-quoted word at", () => {
    expect(line).not.toMatch(/["$`\\!%^&;|\n]/)
  })
})

const dir = mkdtempSync(join(tmpdir(), "start-prompt-"))
const script = join(dir, "argv.cjs")
writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))")
const node = process.execPath

const argvOf = (run: ReturnType<typeof spawnSync>): unknown => {
  expect(run.stderr.toString()).toBe("")
  return JSON.parse(run.stdout.toString())
}

const has = (shell: string): boolean => spawnSync(shell, ["--version"]).error === undefined

describe.skipIf(process.platform === "win32")("on this machine's POSIX shells", () => {
  const withNode = commandLine(["agent", line]).replace("agent", `'${node}' '${script}'`)
  for (const shell of ["sh", "bash", "dash", "zsh", "fish"])
    it.skipIf(!has(shell))(`${shell} passes it as one argument, as it is`, () => {
      expect(argvOf(spawnSync(shell, ["-c", withNode]))).toEqual([line])
    })
})

describe.skipIf(process.platform !== "win32")("on Windows' shells", () => {
  const withNode = `"${node}" "${script}" "${line}"`
  it("cmd passes it as one argument, as it is", () => {
    const run = spawnSync("cmd.exe", ["/d", "/s", "/c", `"${withNode}"`], {
      windowsVerbatimArguments: true,
    })
    expect(argvOf(run)).toEqual([line])
  })
  for (const shell of ["powershell.exe", "pwsh.exe"])
    it.skipIf(!has(shell))(`${shell} passes it as one argument, as it is`, () => {
      const run = spawnSync(shell, ["-NoProfile", "-Command", `& ${withNode}`])
      expect(argvOf(run)).toEqual([line])
    })
})

process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
