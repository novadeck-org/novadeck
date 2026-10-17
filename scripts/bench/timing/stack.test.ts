import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

import { runnerEnv, strays } from "./stack.ts"

// The timing run's boundary: the Novadeck `claude` shim runs the next `claude` on PATH, so a
// real one there would start the developer's real Claude Code with their logins.

const folders = (...names: string[]) => {
  const root = mkdtempSync(join(tmpdir(), "timing-stack-"))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  return names.map((name) => {
    const folder = join(root, name)
    mkdirSync(folder)
    return folder
  })
}

const program = (folder: string, name: string) => {
  writeFileSync(join(folder, name), "#!/bin/sh\n")
  chmodSync(join(folder, name), 0o755)
}

describe("the sandbox's PATH", () => {
  it("holds a real agent CLI wherever one is but the fake's own folder, first", () => {
    const [fake, system, tools] = folders("fake", "system", "tools")
    program(fake!, "claude")
    program(system!, "ls")
    program(tools!, "codex")

    expect(strays([fake, system, tools].join(delimiter))).toEqual([join(tools!, "codex")])
  })

  it("holds none where only the fake's folder has one", () => {
    const [fake, system] = folders("fake", "system")
    program(fake!, "claude")

    expect(strays([fake, system].join(delimiter))).toEqual([])
  })
})

describe("the runner's environment", () => {
  it("is the sandbox's alone, with what the runner itself is told", () => {
    process.env.TIMING_TEST_SECRET = "leaked"
    onTestFinished(() => {
      delete process.env.TIMING_TEST_SECRET
    })
    const sandbox = {
      root: "/tmp/sandbox",
      env: { HOME: "/tmp/sandbox/home", PATH: "/fake:/usr/bin" },
    }

    const env = runnerEnv(sandbox, { token: "t", port: 1234, origin: "http://127.0.0.1:5678" })

    expect(env).toEqual({
      HOME: "/tmp/sandbox/home",
      PATH: "/fake:/usr/bin",
      NOVADECK_TOKEN: "t",
      HOST: "127.0.0.1",
      PORT: "1234",
      NOVADECK_DATABASE: join("/tmp/sandbox", "data", "workspace.sqlite"),
      CORS_ORIGINS: "http://127.0.0.1:5678",
    })
  })
})
