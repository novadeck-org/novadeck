import { spawn } from "node:child_process"

import { describe, expect, it, onTestFinished, vi } from "vitest"

import {
  agentProcesses,
  boundedListing,
  endFollowed,
  parsePs,
  placement,
  parseStat,
  sharedListing,
  stillRunning,
  type Listed,
  type Listing,
} from "./descendants.js"

const row = (pid: number, parent: number, group: number, more: Partial<Listed> = {}): Listed => ({
  pid,
  parent,
  group,
  foreground: 0,
  started: `at ${pid}`,
  zombie: false,
  ...more,
})

// A shell, 10, with its agent, 20, in the foreground, and what they started.
const shell = row(10, 1, 10, { foreground: 20 })
const agent = row(20, 10, 20)
const relay = row(21, 20, 20)
const tool = row(30, 20, 30)
const toolChild = row(31, 30, 30)
const toolGrandchild = row(32, 31, 32)
const sibling = row(40, 10, 40)
const stranger = row(50, 1, 50)
const everything = [shell, agent, relay, tool, toolChild, toolGrandchild, sibling, stranger]
const pids = (ones: readonly { readonly pid: number }[] | undefined) =>
  ones?.map(({ pid }) => pid).toSorted((a, b) => a - b)

describe("a process's listing", () => {
  it("reads /proc's stat, whatever the program's name holds", () => {
    const fields = "S 7 8 8 34816 9 0 0 0 0 0 0 0 0 0 20 0 1 0 987654 0 0"
    expect(parseStat(`42 (node ) helper) ${fields}`)).toEqual({
      pid: 42,
      parent: 7,
      group: 8,
      foreground: 9,
      started: "987654",
      zombie: false,
      tty: "34816",
    })
    expect(parseStat(`42 (node) Z ${fields.slice(2)}`)?.zombie).toBe(true)
    expect(parseStat("42 node")).toBeUndefined()
    expect(parseStat("42 (node) S 7")).toBeUndefined()
  })

  it("reads ps's rows, keeping a start as it is written", () => {
    const output = [
      "  101     1   101   101 Ss   ttys003 Fri Nov  6 15:20:11 2026",
      "  102   101   102    -1 Z+   ?? Fri Nov  6 15:20:12 2026",
      "not a row",
    ].join("\n")
    expect(parsePs(output)).toEqual([
      {
        pid: 101,
        parent: 1,
        group: 101,
        foreground: 101,
        started: "Fri Nov  6 15:20:11 2026",
        zombie: false,
        tty: "ttys003",
      },
      {
        pid: 102,
        parent: 101,
        group: 102,
        foreground: -1,
        started: "Fri Nov  6 15:20:12 2026",
        zombie: true,
        tty: "??",
      },
    ])
  })
})

describe("what follows an agent past its hangup", () => {
  it("is its group and all under it, a tool's group and its children's too", () => {
    expect(pids(agentProcesses(everything, 10, 20))).toEqual([20, 21, 30, 31, 32])
  })

  it("leaves what the shell started beside it, as a nohup or a tmux", () => {
    expect(pids(agentProcesses(everything, 10, 20))).not.toContain(sibling.pid)
  })

  it("holds an agent under a wrapper that leads its group", () => {
    const wrapper = row(20, 10, 20)
    const native = row(25, 20, 20)
    const rows = [shell, wrapper, native, row(35, 25, 35)]
    expect(pids(agentProcesses(rows, 10, 25))).toEqual([20, 25, 35])
  })

  it("holds an agent that took the shell's place, as `exec codex` does", () => {
    const self = row(10, 1, 10, { foreground: 10 })
    expect(pids(agentProcesses([self, row(30, 10, 30)], 10, 10))).toEqual([10, 30])
  })

  it("is nothing once something else holds the foreground, as the person's own program", () => {
    const left = row(20, 1, 77, { zombie: false })
    const theirs = row(60, 10, 60)
    const shellThen = row(10, 1, 10, { foreground: 60 })
    expect(agentProcesses([shellThen, left, theirs], 10, 20)).toBeUndefined()
  })

  it("is nothing with the shell at its prompt, its agent gone, or its shell unlisted", () => {
    expect(agentProcesses([row(10, 1, 10, { foreground: 10 }), agent], 10, 20)).toBeUndefined()
    expect(agentProcesses([shell], 10, 20)).toBeUndefined()
    expect(agentProcesses([shell, row(20, 10, 20, { zombie: true })], 10, 20)).toBeUndefined()
    expect(agentProcesses([agent], 10, 20)).toBeUndefined()
  })
})

describe("what is still running of it", () => {
  const followed = [{ pid: 30, started: "at 30" }]

  it("goes by pid and start, so never a process given that pid since", () => {
    expect(stillRunning([row(30, 1, 30, { started: "later" })], followed)).toEqual([])
  })

  it("takes what a live one started since, and what shares its group", () => {
    const orphanOfIt = row(31, 1, 30)
    const startedSince = row(33, 30, 33)
    const rows = [row(30, 1, 30), orphanOfIt, startedSince, stranger]
    expect(pids(stillRunning(rows, followed))).toEqual([30, 31, 33])
  })

  it("takes no group whose followed members are all gone: its id may be another's", () => {
    const reused = row(70, 1, 30)
    expect(stillRunning([reused], followed)).toEqual([])
  })

  it("ignores zombies, and nothing can reach pid 1", () => {
    expect(stillRunning([row(30, 1, 30, { zombie: true })], followed)).toEqual([])
    expect(
      pids(stillRunning([row(30, 1, 1), row(1, 0, 1, { started: "boot" })], followed)),
    ).toEqual([30])
  })
})

describe("a bounded listing", () => {
  it("gives up on one that's stuck, and keeps a timely one", async () => {
    vi.useFakeTimers()
    onTestFinished(() => void vi.useRealTimers())
    const stuck = boundedListing(() => new Promise(() => {}), 300)()
    await vi.advanceTimersByTimeAsync(300)
    await expect(stuck).resolves.toBeUndefined()
    await expect(boundedListing(() => Promise.resolve([stranger]), 300)()).resolves.toEqual([
      stranger,
    ])
  })
})

describe("a shared listing", () => {
  it("is one for all who ask at once, and a new one a moment on", async () => {
    vi.useFakeTimers({ now: 0 })
    onTestFinished(() => void vi.useRealTimers())
    const list = vi.fn<Listing>(() => Promise.resolve([stranger]))
    const shared = sharedListing(list, 50)
    await Promise.all([shared(), shared(), shared()])
    expect(list).toHaveBeenCalledOnce()
    vi.setSystemTime(40)
    await shared()
    expect(list).toHaveBeenCalledOnce()
    vi.setSystemTime(100)
    await shared()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it("is shared while one is under way, however long it takes", async () => {
    vi.useFakeTimers({ now: 0 })
    onTestFinished(() => void vi.useRealTimers())
    let answer: (rows: readonly Listed[]) => void = () => {}
    const list = vi.fn<Listing>(() => new Promise((resolve) => (answer = resolve)))
    const shared = sharedListing(list, 50)
    const first = shared()
    vi.setSystemTime(500)
    const second = shared()
    answer([stranger])
    await Promise.all([first, second])
    expect(list).toHaveBeenCalledOnce()
  })

  it("tells a failed listing as none", async () => {
    await expect(sharedListing(() => Promise.reject(new Error("no ps")))()).resolves.toBeUndefined()
  })
})

// Real processes, ended by their exact pids: signals here are the point.
describe.skipIf(process.platform === "win32")("ending what is followed", () => {
  const stubborn = (signals: readonly string[]) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `for (const signal of ${JSON.stringify(signals)}) process.on(signal, () => {}); console.log("up"); setInterval(() => {}, 1000)`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    onTestFinished(() => void child.kill("SIGKILL"))
    return new Promise<{ pid: number; gone: Promise<NodeJS.Signals | null> }>((resolve) => {
      const gone = new Promise<NodeJS.Signals | null>((end) => {
        child.once("exit", (_code, signal) => end(signal))
      })
      child.stdout.once("data", () => resolve({ pid: child.pid!, gone }))
    })
  }
  const listed = (pid: number, started = "same"): Listed => row(pid, 1, pid, { started })

  it("ends what ignores SIGTERM by SIGKILL, once the same process is seen again", async () => {
    const { pid, gone } = await stubborn(["SIGHUP", "SIGTERM"])
    const list = vi.fn<Listing>(() => Promise.resolve([listed(pid)]))
    const began = Date.now()
    await endFollowed([{ pid, started: "same" }], () => began, list)
    expect(await gone).toBe("SIGKILL")
    expect(list).toHaveBeenCalledTimes(2)
    expect(Date.now() - began).toBeGreaterThanOrEqual(450)
  })

  it("stops at SIGTERM for what heeds it", async () => {
    const { pid, gone } = await stubborn(["SIGHUP"])
    const began = Date.now()
    await endFollowed(
      [{ pid, started: "same" }],
      () => began,
      () => Promise.resolve([listed(pid)]),
    )
    expect(await gone).toBe("SIGTERM")
  })

  it("signals nothing that has since become another process", async () => {
    const { pid } = await stubborn(["SIGHUP"])
    const kill = vi.spyOn(process, "kill")
    onTestFinished(() => void kill.mockRestore())
    await endFollowed(
      [{ pid, started: "earlier" }],
      () => Date.now(),
      () => Promise.resolve([listed(pid, "later")]),
    )
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
  })

  it("wakes a stopped process, which acts on SIGTERM only once it runs", async () => {
    const { pid, gone } = await stubborn(["SIGHUP"])
    process.kill(pid, "SIGSTOP")
    const began = Date.now()
    await endFollowed(
      [{ pid, started: "same" }],
      () => began,
      () => Promise.resolve([listed(pid)]),
    )
    expect(await gone).toBe("SIGTERM")
    expect(Date.now() - began).toBeLessThan(450)
  })

  it("signals nothing where the processes can't be listed, and says so", async () => {
    const { pid } = await stubborn(["SIGHUP"])
    const kill = vi.spyOn(process, "kill")
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    onTestFinished(() => {
      kill.mockRestore()
      error.mockRestore()
    })
    await endFollowed(
      [{ pid, started: "same" }],
      () => Date.now(),
      () => Promise.resolve(undefined),
    )
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
    expect(error.mock.calls.flat().join(" ")).toContain(String(pid))
  })

  it("waits to the bound, asked anew, so a quit brings it forward", async () => {
    const { pid, gone } = await stubborn(["SIGHUP"])
    const began = Date.now()
    let bound = began + 60_000
    setTimeout(() => (bound = Date.now()), 100)
    await endFollowed(
      [{ pid, started: "same" }],
      () => bound,
      () => Promise.resolve([listed(pid)]),
    )
    expect(await gone).toBe("SIGTERM")
    expect(Date.now() - began).toBeGreaterThanOrEqual(90)
    expect(Date.now() - began).toBeLessThan(5000)
  })

  it("lists nothing when all has ended by itself before the bound", async () => {
    const { pid, gone } = await stubborn(["SIGHUP"])
    const list = vi.fn<Listing>(() => Promise.resolve([listed(pid)]))
    setTimeout(() => process.kill(pid, "SIGKILL"), 50)
    await endFollowed([{ pid, started: "same" }], () => Date.now() + 60_000, list)
    await gone
    expect(list).not.toHaveBeenCalled()
  })
})

describe("an agent's place in its terminal", () => {
  it("names the chain down to the agent, its foreground, and what it started", () => {
    const found = placement(everything, 10, 20)
    expect(found?.chain).toEqual([20])
    expect(found?.foreground).toBe(true)
    expect(pids(found?.below)).toEqual([21, 30, 31, 32])
  })

  it("puts a wrapper in the chain, and not what sits beside it", () => {
    const wrapper = row(15, 10, 20)
    const nested = row(20, 15, 20)
    const found = placement([shell, wrapper, nested, relay, sibling], 10, 20)
    expect(found?.chain).toEqual([15, 20])
    expect(pids(found?.below)).toEqual([21])
  })

  it("is not the foreground when the shell holds it, or a program of another group does", () => {
    expect(placement([row(10, 1, 10, { foreground: 10 }), agent], 10, 20)?.foreground).toBe(false)
    expect(
      placement([row(10, 1, 10, { foreground: 40 }), agent, sibling], 10, 20)?.foreground,
    ).toBe(false)
  })

  it("is nowhere for an agent that does not descend from the shell, or is gone", () => {
    expect(placement(everything, 10, 50)).toBeUndefined()
    expect(placement(everything, 10, 99)).toBeUndefined()
    expect(placement(everything, 10, 10)).toBeUndefined()
    expect(placement([shell, row(20, 10, 20, { zombie: true })], 10, 20)).toBeUndefined()
  })

  it("tells each process under the agent by its parent among them", () => {
    const found = placement(everything, 10, 20)
    expect(found?.lineage.get("32:at 32")).toBe("31:at 31")
    expect(found?.lineage.get("31:at 31")).toBe("30:at 30")
    // The agent itself is no member of what is under it.
    expect(found?.lineage.get("30:at 30")).toBeUndefined()
  })

  it("finds what holds the shell's terminal after its parent left, and nothing else", () => {
    const on = (pid: number, parent: number, tty: string) => row(pid, parent, pid, { tty })
    const rows = [
      on(10, 1, "5"),
      on(20, 10, "5"),
      // A server re-parented to init, still on the terminal; a daemon with none; another terminal's.
      on(60, 1, "5"),
      on(61, 60, "5"),
      on(70, 1, "0"),
      on(80, 1, "6"),
    ]
    const found = placement(rows, 10, 20)
    expect(pids(found?.orphans)).toEqual([60, 61])
    // The terminal is not told, so nothing is claimed.
    expect(placement([row(10, 1, 10, { foreground: 20 }), agent], 10, 20)?.orphans).toEqual([])
  })

  it("leaves out what has ended but not been reaped", () => {
    const found = placement([shell, agent, row(30, 20, 30, { zombie: true })], 10, 20)
    expect(found?.below).toEqual([])
  })
})
