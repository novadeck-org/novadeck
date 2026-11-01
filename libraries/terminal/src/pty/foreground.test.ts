import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { spawn } from "node-pty"
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest"

import {
  hasChildProcess,
  hasTerminalChild,
  parseCommandLine,
  parseProcessStat,
  parsePsRows,
  sampleForeground,
  statName,
} from "./foreground.js"

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
  // copied here is killed for its broken signature, so build one, once: a cold compiler
  // takes seconds, and macOS checks each new binary before it first runs.
  let dir = ""
  let link = ""
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "foreground-version-"))
    writeFileSync(join(dir, "wait.c"), "#include <unistd.h>\nint main(){sleep(30);return 0;}")
    execFileSync("cc", [join(dir, "wait.c"), "-o", join(dir, "2.1.300")])
    link = join(dir, "claude")
    symlinkSync(join(dir, "2.1.300"), link)
  }, 60_000)
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  // Until the program runs: the shell's start and macOS's check of it, under load.
  const runsMs = 20_000
  // Each sample's two ps runs, each bounded at 2 s.
  const sampleMs = 2 * 2_000
  const testMs = runsMs + sampleMs + 5_000

  it(
    "names a program run from the shell by its link, asking ps once while it runs",
    async () => {
      // An interactive shell runs it as a job of its own, holding the terminal, as at a prompt.
      const child = spawn("/bin/zsh", ["-fic", `"${link}"; :`], { name: "xterm-256color" })
      onTestFinished(() => child.kill())
      await vi.waitFor(() => expect(child.process).toBe("2.1.300"), { timeout: runsMs })
      const first = sampleForeground(child, undefined)
      expect(first.process?.name).toBe("claude")
      expect(first.group).not.toBe(child.pid)
      expect(sampleForeground(child, first)).toBe(first)
    },
    testMs,
  )

  it(
    "names a program run in the shell's place by its link too",
    async () => {
      const child = spawn(link, [], { name: "xterm-256color" })
      onTestFinished(() => child.kill())
      // The name is the program's only once the spawned process has run exec, which macOS
      // may hold back while it first checks a new binary.
      await vi.waitFor(() => expect(child.process).toBe("2.1.300"), { timeout: runsMs })
      const sample = sampleForeground(child, undefined)
      expect(sample.process?.name).toBe("claude")
      // Its group is the shell's pid, as at a prompt, so the name decides instead.
      expect(sample.group).toBeNull()
    },
    testMs,
  )
})

describe.skipIf(process.platform === "win32")("a process's children", () => {
  it("tells a shell with a background job from an idle one, and nothing for a bad pid", async () => {
    const job = spawn("sh", ["-c", "sleep 30 & wait"], { cols: 80, rows: 24 })
    onTestFinished(() => job.kill())
    await vi.waitFor(async () => expect(await hasChildProcess(job.pid)).toBe(true))
    const idle = spawn("sh", [], { cols: 80, rows: 24 })
    onTestFinished(() => idle.kill())
    await vi.waitFor(async () => expect(await hasChildProcess(idle.pid)).toBe(false))
    await expect(hasChildProcess(undefined)).resolves.toBeUndefined()
    await expect(hasChildProcess(0)).resolves.toBeUndefined()
    await expect(hasChildProcess(2 ** 22 + 12345)).resolves.toBeUndefined()
  })
})

describe("children on a Unix shell's terminal", () => {
  const rows = (text: string) => parsePsRows(text)

  it("reads ps rows, program names with spaces included", () => {
    expect(
      rows("  10     1 pts/3    zsh\n  11    10 pts/3    /usr/bin/my prog\nnot a row\n"),
    ).toEqual([
      { pid: 10, ppid: 1, tty: "pts/3", comm: "zsh" },
      { pid: 11, ppid: 10, tty: "pts/3", comm: "/usr/bin/my prog" },
    ])
  })

  it("counts a job on the shell's own terminal", () => {
    expect(hasTerminalChild(rows("10 1 pts/3 zsh\n11 10 pts/3 npm\n"), 10)).toBe(true)
  })

  it("ignores a prompt worker on a terminal of its own, as zsh-async's zpty keeps", () => {
    expect(hasTerminalChild(rows("10 1 pts/3 zsh\n11 10 pts/9 zsh\n12 11 pts/9 git\n"), 10)).toBe(
      false,
    )
  })

  it("ignores gitstatusd, powerlevel10k's helper, on the shell's terminal too", () => {
    expect(
      hasTerminalChild(
        rows("10 1 ttys003 zsh\n11 10 ttys003 /home/me/.cache/gitstatus/gitstatusd-darwin-arm64\n"),
        10,
      ),
    ).toBe(false)
  })

  it("is idle with no child, and tells nothing for a shell with no terminal or none listed", () => {
    expect(hasTerminalChild(rows("10 1 pts/3 zsh\n"), 10)).toBe(false)
    expect(hasTerminalChild(rows("10 1 ? zsh\n11 10 ? sleep\n"), 10)).toBeUndefined()
    expect(hasTerminalChild(rows("10 1 ?? zsh\n"), 10)).toBeUndefined()
    expect(hasTerminalChild(rows("11 10 pts/3 sleep\n"), 10)).toBeUndefined()
  })
})

describe("a Windows shell's children, from the relay's tree", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  const onWindows = () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    onTestFinished(() => void Object.defineProperty(process, "platform", platform))
  }
  type Row = { pid: number; startedAt: number; name?: string }
  const tree = (members: Row[] | undefined) => ({
    read: vi.fn<(root: number) => Promise<Row[] | undefined>>(async () => members),
  })
  const at = (pid: number, name?: string): Row => ({ pid, startedAt: 1, ...(name && { name }) })

  it("is busy when a program runs under the shell, as a Start-Job or start /b leaves", async () => {
    onWindows()
    await expect(
      hasChildProcess(10, tree([at(10, "pwsh.exe"), at(11, "pwsh.exe"), at(12, "node.exe")])),
    ).resolves.toBe(true)
  })

  it("is idle when the tree holds only the shell, its console host, or its own launcher", async () => {
    onWindows()
    const trees = tree([
      at(10, "bash.exe"),
      at(11, "bash.exe"),
      at(12, "conhost.exe"),
      at(13, "OpenConsole.exe"),
    ])
    await expect(hasChildProcess(10, trees)).resolves.toBe(false)
    expect(trees.read).toHaveBeenCalledWith(10)
  })

  it("counts any other process when the relay names none", async () => {
    onWindows()
    await expect(hasChildProcess(10, tree([at(10), at(11)]))).resolves.toBe(true)
    await expect(hasChildProcess(10, tree([at(10)]))).resolves.toBe(false)
  })

  it("tells nothing where the relay can't read the tree, or none is given", async () => {
    onWindows()
    await expect(hasChildProcess(10, tree(undefined))).resolves.toBeUndefined()
    await expect(hasChildProcess(10)).resolves.toBeUndefined()
  })
})
