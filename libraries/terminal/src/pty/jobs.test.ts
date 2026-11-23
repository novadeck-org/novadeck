import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import { describe, expect, it, onTestFinished, vi } from "vitest"

import { listedOf, WindowsJobs, windowsJobs, type Keeper } from "./jobs.js"
import { relayMs } from "./trees.js"

/**
 * A stand-in for `novadeck-relay jobs`: it answers each ask as `answer` says, and keeps what it
 * was asked. `answer` returning undefined says nothing back.
 */
const keeper = (answer: (verb: string, words: readonly string[]) => object | undefined) => {
  const asked: string[] = []
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    unref: () => {},
  })
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const [n, verb, ...words] = line.split(" ")
      asked.push([verb, ...words].join(" "))
      const said = answer(verb!, words)
      if (said) stdout.write(`${JSON.stringify({ n: Number(n), ...said })}\n`)
    }
  })
  const started: string[] = []
  const start = (relay: string) => {
    started.push(relay)
    return child as unknown as Keeper
  }
  return { asked, start, started, child }
}

// One process of a job, as the relay lists it.
const member = (pid: number, startedAt: number, parent?: number) => ({
  pid,
  startedAt,
  name: "node.exe",
  ...(parent !== undefined && { parent }),
})

/** A keeper that holds every pid, its job listing `members`. */
const holding = (members: readonly object[] = []) =>
  keeper((verb) => {
    if (verb === "hold") return { held: true }
    if (verb === "members") return { processes: members }
    if (verb === "release") return { released: true }
    if (verb === "end") return { ended: true }
    return { error: "not an ask" }
  })

describe("a Windows terminal's job", () => {
  it("holds its shell, and lists what runs in it as a listing's rows", async () => {
    const relay = holding([member(10, 100), member(30, 600, 25)])
    const jobs = new WindowsJobs(async () => "relay.exe", relay.start)
    const scope = jobs.contain(10)
    expect(await scope.held).toBe(true)
    expect(await scope.members()).toEqual([10, 30])
    expect(await scope.listed!()).toEqual([
      {
        pid: 10,
        parent: 0,
        group: 0,
        foreground: 0,
        started: "100",
        zombie: false,
        command: "node.exe",
      },
      {
        pid: 30,
        parent: 25,
        group: 0,
        foreground: 0,
        started: "600",
        zombie: false,
        command: "node.exe",
      },
    ])
    expect(relay.started).toEqual(["relay.exe"])
    expect(relay.asked[0]).toMatch(/^hold term10-\d+ 10$/)
  })

  it("ends processes by their pid and start", async () => {
    const relay = holding()
    const scope = new WindowsJobs(async () => "relay.exe", relay.start).contain(10)
    await scope.end!([
      { pid: 30, started: "600" },
      { pid: 31, started: "650" },
    ])
    await scope.end!([])
    expect(relay.asked.filter((ask) => ask.startsWith("end"))).toEqual(["end 30:600 31:650"])
  })

  it("lets its job go once the terminal is gone, once, and once its shell left it empty", async () => {
    const relay = holding([])
    const jobs = new WindowsJobs(async () => "relay.exe", relay.start)
    const gone = jobs.contain(10)
    gone.done!()
    gone.done!()
    const emptied = jobs.contain(11)
    await emptied.exited()
    await new Promise((resolve) => setImmediate(resolve))
    const released = relay.asked.filter((ask) => ask.startsWith("release"))
    expect(released).toHaveLength(2)
    expect(new Set(released).size).toBe(2)
  })

  it("keeps the job of a shell that exited leaving something running in it", async () => {
    const relay = holding([member(30, 600)])
    const scope = new WindowsJobs(async () => "relay.exe", relay.start).contain(10)
    await scope.exited()
    expect(relay.asked.some((ask) => ask.startsWith("release"))).toBe(false)
  })

  it("gives the rest none where the relay keeps no jobs, as an older one", async () => {
    const relay = keeper(() => ({ error: "not an ask" }))
    const jobs = new WindowsJobs(async () => "relay.exe", relay.start)
    expect(await jobs.contain(10).held).toBe(false)
    expect(jobs.active()).toBe(false)
    const next = jobs.contain(11)
    expect(await next.held).toBe(false)
    expect(await next.members()).toBeUndefined()
    expect(relay.asked).toHaveLength(1)
  })

  it("goes on for the rest where a hold fails for its program alone", async () => {
    let first = true
    const relay = keeper((verb) => {
      if (verb !== "hold") return { processes: [] }
      const held = !first
      first = false
      return held ? { held } : { held, error: "it has ended" }
    })
    const jobs = new WindowsJobs(async () => "relay.exe", relay.start)
    expect(await jobs.contain(10).held).toBe(false)
    expect(jobs.active()).toBe(true)
    expect(await jobs.contain(11).held).toBe(true)
  })

  it("goes on for the rest where a hold comes late, letting that one go", async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    let first = true
    const relay = keeper((verb) => {
      if (verb !== "hold") return { released: true }
      if (first) {
        first = false
        return undefined
      }
      return { held: true }
    })
    const jobs = new WindowsJobs(async () => "relay.exe", relay.start)
    const slow = jobs.contain(10).held
    await vi.advanceTimersByTimeAsync(relayMs)
    expect(await slow).toBe(false)
    expect(jobs.active()).toBe(true)
    expect(relay.asked[1]).toBe(relay.asked[0]!.replace(/^hold (\S+) .*$/, "release $1"))
    expect(await jobs.contain(11).held).toBe(true)
  })

  it("lets its keeper go as the runner closes, and starts another for a later ask", async () => {
    const relay = holding()
    const jobs = new WindowsJobs(async () => "relay.exe", relay.start)
    jobs.warm()
    await new Promise((resolve) => setImmediate(resolve))
    expect(relay.started).toHaveLength(1)
    jobs.close()
    expect(relay.child.stdin.writableEnded).toBe(true)
    await jobs.contain(10).held
    expect(relay.started).toHaveLength(2)
  })

  it("tells nothing of a job once its relay has gone, and starts another for the next", async () => {
    const relay = holding([member(10, 100)])
    const jobs = new WindowsJobs(async () => "relay.exe", relay.start)
    const scope = jobs.contain(10)
    expect(await scope.held).toBe(true)
    relay.child.emit("exit", 1)
    expect(relay.started).toHaveLength(1)
    await jobs.contain(11).held
    expect(relay.started).toHaveLength(2)
  })

  it("is there on Windows alone", () => {
    const jobs = windowsJobs(async () => undefined, "win32")
    expect(jobs).toBeInstanceOf(WindowsJobs)
    jobs?.close()
    expect(windowsJobs(async () => "relay.exe", "linux")).toBeUndefined()
  })
})

describe("a job's processes as a listing's rows", () => {
  it("reads the relay's members, leaving out what it can't", () => {
    expect(listedOf(null)).toBeUndefined()
    expect(listedOf([{ pid: "x" }, member(7, 70, 3), { pid: 8 }])).toEqual([
      {
        pid: 7,
        parent: 3,
        group: 0,
        foreground: 0,
        started: "70",
        zombie: false,
        command: "node.exe",
      },
    ])
  })
})
