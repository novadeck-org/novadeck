import { spawn } from "node:child_process"
import { once } from "node:events"

import { describe, expect, it, vi } from "vitest"

import { nativeStandIn } from "../testing.js"
import { forceKill, spawnPty, type ProcessTrees } from "./pty.js"

// A stand-in for node-pty's terminal, which on Windows throws on any signal.
// `pid` null: node-pty doesn't know the process yet.
const ptyStandIn = (platform: NodeJS.Platform, pid: number | null = 4242) => {
  const signals: (string | undefined)[] = []
  return {
    signals,
    pid: pid ?? undefined,
    kill: (signal?: string) => {
      if (platform === "win32" && signal) throw new Error("Signals not supported on windows.")
      signals.push(signal)
    },
  }
}

/** Whether a process is still running. */
const isRunning = (id: number): boolean => {
  try {
    process.kill(id, 0)
    return true
  } catch {
    return false
  }
}

describe("forcing a terminal's program to end", () => {
  it("sends SIGKILL on Linux and macOS", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const ended: number[] = []
      const terminal = ptyStandIn(platform)
      // eslint-disable-next-line no-await-in-loop -- Each platform is checked in turn.
      await forceKill(terminal, platform, (pid) => void ended.push(pid))
      expect(terminal.signals).toEqual(["SIGKILL"])
      expect(ended).toEqual([])
    }
  })

  it("ends the process by its id on Windows, giving node-pty no signal", async () => {
    const ended: number[] = []
    const terminal = ptyStandIn("win32")
    await forceKill(terminal, "win32", (pid) => void ended.push(pid))
    expect(ended).toEqual([4242])
    expect(terminal.signals).toEqual([])
  })

  it("ends nothing on Windows before node-pty knows the process, as id 0 would end the host", async () => {
    const ended: number[] = []
    const terminal = ptyStandIn("win32", null)
    await expect(forceKill(terminal, "win32", (pid) => void ended.push(pid))).rejects.toThrow(
      "The program has no process id yet.",
    )
    expect(ended).toEqual([])
    expect(terminal.signals).toEqual([])
  })

  it.runIf(process.platform === "win32")(
    "ends on Windows every program the process started, which could keep its console open",
    async ({ onTestFinished }) => {
      const keep = "setInterval(() => {}, 1e6)"
      const parent = spawn(
        process.execPath,
        [
          "-e",
          `const started = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(keep)}], { stdio: "ignore" }); console.log(started.pid); ${keep}`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      )
      const { pid } = parent
      if (pid === undefined) throw new Error("The test's process did not start.")
      const [data] = (await once(parent.stdout, "data")) as [Buffer]
      const started = Number(data.toString().trim())
      onTestFinished(() => {
        for (const leftover of [pid, started]) {
          try {
            process.kill(leftover)
          } catch {
            // Already ended.
          }
        }
      })
      expect(isRunning(started)).toBe(true)

      await forceKill(ptyStandIn("win32", pid), "win32")
      await vi.waitFor(() => {
        expect(isRunning(started)).toBe(false)
        expect(isRunning(pid)).toBe(false)
      })
    },
  )
})

const noTrees: ProcessTrees = { read: async () => undefined, end: async () => {} }

const start = (standIn: ReturnType<typeof nativeStandIn>, platform: NodeJS.Platform) =>
  spawnPty({
    file: "shell",
    args: [],
    cwd: "/",
    env: {},
    cols: 80,
    rows: 24,
    platform,
    native: standIn.spawn,
  })

describe("a pty", () => {
  it("has no process id while a ConPTY names it 0, and drew once output arrived", () => {
    const standIn = nativeStandIn({ conpty: true })
    const pty = start(standIn, "win32")
    expect(pty.pid).toBeUndefined()
    expect(pty.drawn).toBe(false)
    standIn.draw("$ ")
    expect(pty.pid).toBe(2 ** 30)
    expect(pty.drawn).toBe(true)
  })

  it("reports an exit once, its code null where the program's isn't known yet", () => {
    const standIn = nativeStandIn()
    const pty = start(standIn, "linux")
    const exits: unknown[] = []
    pty.onExit((exit) => exits.push(exit))
    standIn.exit(undefined)
    standIn.exit(0)
    expect(exits).toEqual([{ code: null, signal: null }])
    expect(pty.exited).toBe(true)
  })

  it("names the signal that ended it, and no code then", () => {
    const standIn = nativeStandIn()
    const pty = start(standIn, "linux")
    const exits: unknown[] = []
    pty.onExit((exit) => exits.push(exit))
    standIn.exit(0, 9)
    expect(exits).toEqual([{ code: null, signal: "SIGKILL" }])
  })

  it("ends on Linux and macOS with a kill, and SIGKILL past its grace", async () => {
    vi.useFakeTimers()
    try {
      const standIn = nativeStandIn({ pid: 2 ** 30 })
      const pty = start(standIn, "linux")
      const ended = pty.end({ graceMs: 1_000, treeGraceMs: 3_000, trees: noTrees })
      // macOS reads the foreground with ps first, a real process the fake clock doesn't run.
      await vi.waitFor(() => expect(standIn.calls).toEqual(["kill"]))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(standIn.calls).toEqual(["kill", "kill SIGKILL"])
      standIn.exit(0, 9)
      await ended
    } finally {
      vi.useRealTimers()
    }
  })

  it("reads no tree on Windows once its program has exited, as its id may name another", async () => {
    const standIn = nativeStandIn({ conpty: true })
    const pty = start(standIn, "win32")
    standIn.draw("C:\\> ")
    standIn.exit(0)
    const reads: unknown[] = []
    const trees: ProcessTrees = { ...noTrees, read: async (root) => void reads.push(root) }
    await pty.end({ graceMs: 1_000, treeGraceMs: 3_000, trees })
    expect(reads).toEqual([])
  })

  it("is taken as ended on Windows when its kill waits for a draw, as its id isn't known", async () => {
    vi.useFakeTimers()
    try {
      const standIn = nativeStandIn({ conpty: true })
      const pty = start(standIn, "win32")
      const exits: unknown[] = []
      pty.onExit((exit) => exits.push(exit))
      const reads: unknown[] = []
      const trees: ProcessTrees = { ...noTrees, read: async (root) => void reads.push(root) }
      const ended = pty.end({ graceMs: 1_000, treeGraceMs: 3_000, trees })
      await vi.advanceTimersByTimeAsync(1_000)
      await ended
      // Nothing was read or ended by id 0, which would name the host.
      expect(reads).toEqual([])
      expect(exits).toEqual([{ code: null, signal: null }])
      // The queued kill runs at the first draw; its exit isn't reported again.
      standIn.draw("$ ")
      expect(exits).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reads a drawn Windows terminal's tree first, then ends it with its kill alone", async () => {
    vi.useFakeTimers()
    try {
      const standIn = nativeStandIn({ conpty: true })
      const pty = start(standIn, "win32")
      standIn.draw("$ ")
      const reads: unknown[] = []
      const trees: ProcessTrees = {
        read: async (root) => {
          reads.push(root)
          return []
        },
        end: async () => {},
      }
      const exits: unknown[] = []
      pty.onExit((exit) => exits.push(exit))
      const ended = pty.end({ graceMs: 1_000, treeGraceMs: 3_000, trees })
      await vi.advanceTimersByTimeAsync(0)
      expect(reads).toEqual([2 ** 30])
      expect(standIn.calls).toEqual(["kill"])
      expect(exits).toEqual([{ code: null, signal: null }])
      await vi.advanceTimersByTimeAsync(1_000)
      await ended
      // A drawn ConPTY's kill ended its shell, whose id may name another process now.
      expect(standIn.calls).toEqual(["kill"])
    } finally {
      vi.useRealTimers()
    }
  })
})
