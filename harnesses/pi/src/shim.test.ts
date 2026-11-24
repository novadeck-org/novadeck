import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { keptFlags, resumeFlags } from "@novadeck/harness-core/kept-flags"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { extensionFile } from "./plugin.js"
import { kept, makeCmdShim, posixShim, shims } from "./shim.js"

const run = promisify(execFile)

describe.skipIf(process.platform === "win32")("pi's shim", () => {
  let root: string
  let shell: string
  let extension: string
  let path: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-shim-"))
    // Novadeck's shell folder: the shim in bin, the extension in plugins/pi.
    shell = join(root, "shell")
    await mkdir(join(shell, "bin"), { recursive: true })
    await mkdir(join(shell, "plugins", "pi"), { recursive: true })
    extension = join(shell, "plugins", "pi", extensionFile)
    await writeFile(extension, "export default () => {}\n")
    await writeFile(join(shell, "bin", "pi"), posixShim(), { mode: 0o700 })
    // The real pi: prints the words it was given, one a line.
    const real = join(root, "real")
    await mkdir(real)
    await writeFile(join(real, "pi"), '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n')
    await chmod(join(real, "pi"), 0o755)
    path = `${join(shell, "bin")}:${real}:/usr/bin:/bin`
  })

  afterAll(() => rm(root, { recursive: true, force: true }))

  const words = async (args: readonly string[], env: NodeJS.ProcessEnv = {}) => {
    const { stdout } = await run(join(shell, "bin", "pi"), args, {
      env: { PATH: path, NOVADECK_TERMINAL_ID: "t1", NOVADECK_SHIMS: "claude pi", ...env },
    })
    return stdout.split("\n").filter(Boolean)
  }

  it("loads Novadeck's extension for a session, before the person's own words", async () => {
    expect(await words([])).toEqual(["-e", extension])
    expect(await words(["--model", "openai/gpt-6", "fix it"])).toEqual([
      "-e",
      extension,
      "--model",
      "openai/gpt-6",
      "fix it",
    ])
    expect(await words(["--mode", "text"])).toEqual(["-e", extension, "--mode", "text"])
  })

  it("runs pi's other commands, help, version and print runs as they are", async () => {
    expect(await words(["install", "npm:x"])).toEqual(["install", "npm:x"])
    expect(await words(["auth", "login", "openai"])).toEqual(["auth", "login", "openai"])
    expect(await words(["--version"])).toEqual(["--version"])
    expect(await words(["-p", "hi"])).toEqual(["-p", "hi"])
    expect(await words(["--mode", "json", "hi"])).toEqual(["--mode", "json", "hi"])
  })

  it("reads an option's value as its value, never as a command or a print flag", async () => {
    expect(await words(["--name", "-p"])).toEqual(["-e", extension, "--name", "-p"])
    expect(await words(["hello", "install"])).toEqual(["-e", extension, "hello", "install"])
  })

  it("leaves pi alone outside Novadeck's terminals, or where pi isn't connected", async () => {
    expect(await words([], { NOVADECK_TERMINAL_ID: "" })).toEqual([])
    expect(await words([], { NOVADECK_SHIMS: "claude codex" })).toEqual([])
  })
})

describe("pi's Windows shim", () => {
  it("loads the extension the same way, and passes the words on whole", () => {
    const cmd = makeCmdShim()
    expect(cmd).toContain(`"%novadeck_real%" -e "%novadeck_extension%" %*`)
    expect(cmd).toContain("for %%c in (install remove uninstall update list config auth mcp)")
    expect(shims("win32")).toEqual([{ path: "pi.cmd", content: cmd }])
  })
})

describe("what a resume of pi carries over", () => {
  it("leaves its model and thinking level to the session, and gives back its command-line flags", () => {
    const launched = keptFlags(
      ["--model", "openai/gpt-6", "--thinking", "high", "--no-mcp", "-a", "do it"],
      kept,
    )
    expect(launched).toEqual([
      "--model",
      "openai/gpt-6",
      "--thinking",
      "high",
      "--no-mcp",
      "--approve",
    ])
    expect(resumeFlags(launched, {}, kept)).toEqual(["--no-mcp", "--approve"])
  })

  it("keeps nothing of a print run", () => {
    expect(keptFlags(["-p", "hi", "--no-mcp"], kept)).toEqual([])
  })
})
