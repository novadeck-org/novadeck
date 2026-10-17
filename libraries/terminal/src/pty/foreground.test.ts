import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { spawn } from "node-pty"
import { describe, expect, it, vi } from "vitest"

import { parseCommandLine, parseProcessStat, sampleForeground, statName } from "./foreground.js"

const cmdline = (...args: string[]): Buffer => Buffer.from(`${args.join("\0")}\0`)

describe("Linux foreground inspection", () => {
  it("parses the controlling terminal and foreground group after a parenthesized command", () => {
    expect(parseProcessStat("42 (node ) helper) S 1 42 42 34816 99 0")).toEqual({
      ppid: 1,
      pgrp: 42,
      tty: 34816,
      tpgid: 99,
    })
    expect(parseProcessStat("42 (node) S 1 invalid 42 34816 99 0")).toBeNull()
    expect(parseProcessStat("broken")).toBeNull()
  })

  it("splits a command line into arguments, keeping empty ones", () => {
    expect(parseCommandLine(cmdline("/usr/bin/node", "/a path/bin/codex", "", "--yes"))).toEqual([
      "/usr/bin/node",
      "/a path/bin/codex",
      "",
      "--yes",
    ])
    expect(parseCommandLine(Buffer.alloc(0))).toEqual([])
  })

  it("drops the NUL padding a retitled process leaves, keeping empty arguments before it", () => {
    const retitled = Buffer.concat([Buffer.from("claude"), Buffer.alloc(200)])
    expect(parseCommandLine(retitled)).toEqual(["claude"])
    expect(parseCommandLine(Buffer.from("node\0\0--yes\0\0\0"))).toEqual(["node", "", "--yes"])
  })

  it("truncates a command line to its bounds", () => {
    const args = parseCommandLine(cmdline(...Array.from({ length: 70 }, () => "x".repeat(5000))))
    expect(args).toHaveLength(64)
    expect(args.every((arg) => arg.length === 4096)).toBe(true)
  })

  it.skipIf(process.platform !== "linux")(
    "reads the command line again only once the foreground group or name changes",
    () => {
      const child = { pid: process.pid, process: "node" }
      const first = sampleForeground(child, undefined)
      expect(first.process?.name).toBe("node")
      const cached = { ...first, process: { name: "node", argv: ["cached"] } }
      expect(sampleForeground(child, cached)).toBe(cached)
      expect(sampleForeground({ ...child, process: "other" }, cached).process).toEqual({
        name: "other",
        argv: first.process?.argv ?? null,
      })
      expect(sampleForeground(child, { ...cached, group: -1 }).process?.argv).not.toEqual([
        "cached",
      ])
    },
  )
})

describe("a process's name, as /proc names it", () => {
  it("is what its stat holds in parentheses, which may hold parentheses itself", () => {
    expect(statName("42 (codex) S 1 42 42 34816 99 0")).toBe("codex")
    expect(statName("42 (node ) helper) S 1 42")).toBe("node ) helper")
    expect(statName("garbage")).toBeNull()
  })
})

describe.skipIf(process.platform !== "darwin")("macOS foreground naming", () => {
  // A program installed as a link into a versioned file, as Claude Code is. A system binary
  // copied here is killed for its broken signature, so build one.
  const versioned = (): { dir: string; link: string } => {
    const dir = mkdtempSync(join(tmpdir(), "foreground-version-"))
    writeFileSync(join(dir, "wait.c"), "#include <unistd.h>\nint main(){sleep(30);return 0;}")
    execFileSync("cc", [join(dir, "wait.c"), "-o", join(dir, "2.1.300")])
    symlinkSync(join(dir, "2.1.300"), join(dir, "claude"))
    return { dir, link: join(dir, "claude") }
  }

  it("names a program run from the shell by its link, asking ps once while it runs", async () => {
    const { dir, link } = versioned()
    // An interactive shell runs it as a job of its own, holding the terminal, as at a prompt.
    const child = spawn("/bin/zsh", ["-fic", `"${link}"; :`], { name: "xterm-256color" })
    try {
      await vi.waitFor(() => expect(child.process).toBe("2.1.300"), { timeout: 10_000 })
      const first = sampleForeground(child, undefined)
      expect(first.process?.name).toBe("claude")
      expect(first.group).not.toBe(child.pid)
      expect(sampleForeground(child, first)).toBe(first)
    } finally {
      child.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("names a program run in the shell's place by its link too", async () => {
    const { dir, link } = versioned()
    const child = spawn(link, [], { name: "xterm-256color" })
    try {
      // The name is the program's only once the spawned process has run exec, which macOS
      // may hold back while it first checks a new binary.
      await vi.waitFor(() => expect(child.process).toBe("2.1.300"), { timeout: 10_000 })
      const sample = sampleForeground(child, undefined)
      expect(sample.process?.name).toBe("claude")
      // Its group is the shell's pid, as at a prompt, so the name decides instead.
      expect(sample.group).toBeNull()
    } finally {
      child.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
