import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

import { describe, expect, it, onTestFinished, vi } from "vitest"

import type { TerminalEvent } from "../contract.js"
import type { ApartProcess } from "../pty/apart.js"
import type { Listing } from "../pty/descendants.js"
import type { NativeSpawn, ProcessTrees } from "../pty/pty.js"
import { nativeStandIn } from "../testing.js"
import { createTerminalHost, type TerminalHostOptions } from "./host.js"
import type { RunSpec } from "./terminal.js"

type Program = ReturnType<typeof nativeStandIn>

const spec: RunSpec = { file: "shell", args: [], cwd: "/", env: {}, cols: 20, rows: 4 }

const noTrees: ProcessTrees = { read: async () => [], end: async () => {} }

// The stand-in shell: a pid nothing has, so a signal for it reaches no one.
const shellPid = 2 ** 30

/** A host over stand-in programs, one for each terminal it opens, in turn. */
const hostOf = (
  limits: Partial<TerminalHostOptions["limits"]> = {},
  failed?: TerminalHostOptions["failed"],
  more: Partial<
    Pick<TerminalHostOptions, "follows" | "listing" | "kill" | "apart" | "settle">
  > = {},
) => {
  const programs: Program[] = []
  const native: NativeSpawn = (...args) => {
    const program = nativeStandIn({ pid: shellPid })
    programs.push(program)
    return program.spawn(...args)
  }
  const host = createTerminalHost({
    eventBytes: (event: TerminalEvent, terminalId) =>
      Buffer.byteLength(JSON.stringify({ ...event, terminalId })),
    limits: {
      historyBytes: 1024 * 1024,
      subscriberBytes: 4 * 1024 * 1024,
      ackWindowBytes: 256 * 1024,
      snapshotBytes: 32 * 1024 * 1024,
      maxTerminals: 8,
      maxRetained: 8,
      ...limits,
    },
    scrollback: 1000,
    kill: { graceMs: 1000, treeGraceMs: 3000, shutdownTreesMs: 3000, shutdownTreeGraceMs: 1000 },
    trees: noTrees,
    pty: { native, platform: "linux" },
    ...(failed && { failed }),
    ...more,
  })
  // The stand-ins end only when told to.
  onTestFinished(async () => {
    const done = host.shutdown()
    for (const program of programs) program.exit(0)
    await done
  })
  const evicted: string[] = []
  host.on("evicted", (id) => evicted.push(id))
  const open = (id: string) => {
    const place = host.reserve(id)
    try {
      return place.open(spec, undefined)
    } finally {
      place.done()
    }
  }
  /** Ends terminal `id`'s program, and waits for its exit to be handled. */
  const exit = async (id: string, index: number) => {
    programs[index]!.exit(0)
    await host.terminal(id)!.exited
  }
  return { host, programs, evicted, open, exit }
}

// An end held open by a real process, ended by its exact pid: one in a group of its own that
// ignores the hangup and answers SIGTERM, as an agent's tool, with the listing a shell would give.
describe.skipIf(process.platform === "win32")("a terminal's end that follows its agent", () => {
  const tool = () => {
    const child = spawn(
      process.execPath,
      ["-e", 'process.on("SIGHUP", () => {}); console.log("up"); setInterval(() => {}, 1000)'],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    )
    onTestFinished(() => void child.kill("SIGKILL"))
    const pid = child.pid!
    const row = { foreground: pid, started: "same", zombie: false }
    const rows = [
      { ...row, pid: shellPid, parent: 1, group: shellPid },
      { ...row, pid, parent: shellPid, group: pid },
    ]
    let hungUp = () => {}
    // Once the walk is done and the hangup sent: a shell gone sooner leaves nothing to follow.
    const walked = new Promise<void>((resolve) => {
      hungUp = () => setTimeout(resolve, 20)
    })
    const listing: Listing = () => {
      hungUp()
      return Promise.resolve(rows)
    }
    return new Promise<{
      pid: number
      listing: Listing
      gone: Promise<unknown>
      walked: Promise<void>
    }>((resolve) => {
      const gone = new Promise((end) => {
        child.once("exit", end)
      })
      child.stdout.once("data", () => resolve({ pid, gone, listing, walked }))
    })
  }
  const kill = { graceMs: 1000, treeGraceMs: 60_000, shutdownTreesMs: 300, shutdownTreeGraceMs: 50 }

  it("asks who runs there, and isn't evicted while it waits", async () => {
    const { pid, gone, listing, walked } = await tool()
    const follows = vi.fn<(id: string) => number | undefined>((id) =>
      id === "a" ? pid : undefined,
    )
    const { host, evicted, open, exit } = hostOf({ maxRetained: 0 }, undefined, {
      follows,
      listing,
      kill,
    })
    open("a")
    const closing = host.terminate("a")
    await walked
    await exit("a", 0)
    open("b")
    await exit("b", 1)
    expect(follows).toHaveBeenCalledWith("a")
    expect(evicted).toEqual(["b"])
    expect(host.terminal("a")).toBeDefined()
    process.kill(pid, "SIGKILL")
    await gone
    await closing
    open("c")
    expect(evicted).toEqual(["b", "a"])
  })

  it("is brought forward by a shutdown", async () => {
    const { pid, gone, listing, walked } = await tool()
    const { host, open, programs } = hostOf({}, undefined, {
      follows: () => pid,
      listing,
      kill,
    })
    open("a")
    void host.terminate("a")
    await walked
    programs[0]!.exit(0)
    const began = Date.now()
    await Promise.all([host.shutdown(), gone])
    expect(Date.now() - began).toBeLessThan(10_000)
  })
})

// What a harness runs apart from the terminal, as Claude Code's background service: the agent
// started it, and it is still its child at the close, yet the close leaves it running.
describe.skipIf(process.platform === "win32")("a terminal's end with what runs apart", () => {
  // An agent that ignores the hangup and answers SIGTERM, and a service in a group of its own.
  const running = () => {
    const child = spawn(
      process.execPath,
      ["-e", 'process.on("SIGHUP", () => {}); setInterval(() => {}, 1000)'],
      { detached: true, stdio: "ignore" },
    )
    onTestFinished(() => void child.kill("SIGKILL"))
    const gone = new Promise((end) => child.once("exit", end))
    return {
      pid: child.pid!,
      gone,
      alive: () => child.exitCode === null && child.signalCode === null,
    }
  }
  const close = async (keep: boolean) => {
    const agent = running()
    const service = running()
    const asked: string[] = []
    const apart = async (id: string): Promise<ApartProcess[]> => {
      asked.push(id)
      return keep ? [{ pid: service.pid, start: "same" }] : []
    }
    const row = { started: "same", zombie: false, foreground: 0 }
    let listed = () => {}
    const walked = new Promise<void>((resolve) => {
      listed = () => setTimeout(resolve, 20)
    })
    const listing: Listing = async () => {
      listed()
      return [
        { ...row, pid: shellPid, parent: 1, group: shellPid, foreground: agent.pid },
        { ...row, pid: agent.pid, parent: shellPid, group: agent.pid },
        { ...row, pid: service.pid, parent: agent.pid, group: service.pid },
      ]
    }
    const { host, open, programs } = hostOf({}, undefined, {
      follows: () => agent.pid,
      listing,
      apart,
      kill: { graceMs: 1000, treeGraceMs: 50, shutdownTreesMs: 300, shutdownTreeGraceMs: 50 },
    })
    open("a")
    const closing = host.terminate("a")
    await walked
    programs[0]!.exit(0)
    await closing
    await agent.gone
    return { service, asked }
  }

  it("leaves what the harness keeps apart running, though the agent started it", async () => {
    const { service, asked } = await close(true)
    expect(asked).toEqual(["a"])
    expect(service.alive()).toBe(true)
  })

  it("ends it with the agent where the harness keeps nothing, as before", async () => {
    const { service } = await close(false)
    await service.gone
    expect(service.alive()).toBe(false)
  })
})

describe("a terminal host's limits", () => {
  it("refuses a terminal past maxTerminals, counting those starting", () => {
    const { host, open } = hostOf({ maxTerminals: 2 })
    open("a")
    const starting = host.reserve("b")
    expect(() => host.reserve("c")).toThrow(expect.objectContaining({ code: "TERMINAL_LIMIT" }))
    starting.done()
    expect(() => host.reserve("c").done()).not.toThrow()
  })

  it("lets the oldest exited terminal no one reads go to make room", async () => {
    const { host, evicted, open, exit } = hostOf({ maxTerminals: 2 })
    open("a")
    open("b")
    await exit("b", 1)
    await exit("a", 0)
    open("c")
    // b exited first.
    expect(evicted).toEqual(["b"])
    expect(host.terminal("b")).toBeUndefined()
    expect(host.terminal("a")).toBeDefined()
  })

  it("keeps maxRetained exited terminals for late viewers, letting the oldest go", async () => {
    const { host, evicted, open, exit } = hostOf({ maxRetained: 1 })
    open("a")
    open("b")
    await exit("a", 0)
    expect(evicted).toEqual([])
    await exit("b", 1)
    expect(evicted).toEqual(["a"])
    expect(host.terminal("b")).toBeDefined()
  })

  it("keeps an exited terminal while it is read, and lets it go once its viewer leaves", async () => {
    const { host, evicted, open, exit } = hostOf({ maxRetained: 0 })
    open("a")
    open("b")
    const viewer = host.attach("a", "viewer", { mode: "observe" })
    expect(await viewer.next()).toEqual({
      value: { type: "attached", mode: "observe" },
      done: false,
    })
    await exit("a", 0)
    await exit("b", 1)
    expect(evicted).toEqual(["b"])
    await viewer.return(undefined)
    expect(evicted).toEqual(["b", "a"])
  })
})

// No process under any terminal, at once: the platform's own listing (`ps` on macOS) answers on
// its own clock, which fake timers don't move.
const idle: Listing = () => Promise.resolve([])

describe("a terminal host's close", () => {
  it("ends the program, then keeps the closed terminal for its viewers until they're done", async () => {
    const { host, programs, open } = hostOf()
    const terminal = open("a")
    const viewer = host.attach("a", "viewer", { mode: "observe" })
    await viewer.next()
    await viewer.next()
    const closing = host.terminate("a")
    expect(host.closing("a")).toBe(true)
    // The stand-in exits on its kill's grace; its exit is handled in turn.
    programs[0]!.exit(0)
    await closing
    host.remove("a")
    expect(host.draining("a")).toBe(true)
    expect(host.terminal("a")).toBe(terminal)
    expect(await viewer.next()).toMatchObject({ value: { type: "exited" } })
    // Its viewer read the exit: the stream ends, and the closed terminal goes.
    expect(await viewer.next()).toMatchObject({ done: true })
    expect(host.draining("a")).toBe(false)
    expect(host.terminal("a")).toBeUndefined()
  })

  it("leaves the program running for what it still saves, then ends it", async () => {
    vi.useFakeTimers()
    onTestFinished(() => void vi.useRealTimers())
    const { programs, host, open } = hostOf({}, undefined, { listing: idle, settle: () => 300 })
    open("a")
    const closing = host.terminate("a")
    await vi.advanceTimersByTimeAsync(299)
    expect(programs[0]!.calls.filter((call) => call.startsWith("kill"))).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(programs[0]!.calls.filter((call) => call.startsWith("kill"))).not.toEqual([])
    programs[0]!.exit(0)
    await closing
  })

  it("ends the wait at once when the program exits by itself meanwhile", async () => {
    vi.useFakeTimers()
    onTestFinished(() => void vi.useRealTimers())
    const { programs, host, open } = hostOf({}, undefined, { listing: idle, settle: () => 2_000 })
    open("a")
    let closed = false
    const closing = host.terminate("a").then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(100)
    programs[0]!.exit(0)
    await vi.advanceTimersByTimeAsync(0)
    await closing
    expect(closed).toBe(true)
    expect(programs[0]!.calls.filter((call) => call.startsWith("kill"))).toEqual([])
  })

  it("leaves a program no more than 1.5 s for what it saves as the host shuts down", async () => {
    vi.useFakeTimers()
    onTestFinished(() => void vi.useRealTimers())
    const { programs, host, open } = hostOf({}, undefined, { listing: idle, settle: () => 2_000 })
    open("a")
    const done = host.shutdown()
    await vi.advanceTimersByTimeAsync(1_499)
    expect(programs[0]!.calls.filter((call) => call.startsWith("kill"))).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(programs[0]!.calls.filter((call) => call.startsWith("kill"))).not.toEqual([])
    programs[0]!.exit(0)
    await vi.advanceTimersByTimeAsync(5_000)
    await done
  })

  it("ends an exited terminal's close at once", async () => {
    const { host, open, exit } = hostOf()
    open("a")
    await exit("a", 0)
    await host.terminate("a")
    expect(host.closing("a")).toBe(false)
  })

  it("releases an owner on every terminal, closed ones too, letting those it read go", async () => {
    const { host, open, exit } = hostOf()
    const a = open("a")
    const b = open("b")
    a.attach("viewer", { mode: "observe" })
    b.attach("viewer", { mode: "control" })
    await exit("a", 0)
    host.remove("a")
    host.release("viewer")
    expect(b.attached).toBe(0)
    expect(b.controller).toBeUndefined()
    expect(host.terminal("a")).toBeUndefined()
  })
})

describe("a terminal host's terminals", () => {
  it("tells of a terminal's listener that threw, with the terminal's id", async () => {
    const failed: unknown[] = []
    const { host, programs, open } = hostOf({}, (error, event, id) =>
      failed.push([(error as Error).message, event, id]),
    )
    open("a").on("title", () => {
      throw new Error("no title")
    })
    programs[0]!.draw("\u001b]0;Hello\u0007")
    await host.terminal("a")!.readScreen()
    expect(failed).toEqual([["no title", "title", "a"]])
  })

  it("ends one close at a time, its second call the first's", async () => {
    const { host, programs, open } = hostOf()
    open("a")
    const first = host.terminate("a")
    expect(host.terminate("a")).toBe(first)
    programs[0]!.exit(0)
    await first
  })

  it("keeps a closed terminal while an attach to it is under way", async () => {
    const { host, open, exit } = hostOf()
    open("a")
    await exit("a", 0)
    const viewer = host.attach("a", "viewer", { mode: "observe" })
    const attached = viewer.next()
    // Closed while the attach waits its turn: it is kept for it, and goes once it's read.
    host.remove("a")
    expect(host.draining("a")).toBe(true)
    expect(await attached).toMatchObject({ value: { type: "attached" } })
    expect(await viewer.next()).toMatchObject({ value: { type: "snapshot" } })
    expect(await viewer.next()).toMatchObject({ done: true })
    expect(host.draining("a")).toBe(false)
  })

  it("discards an ended terminal at once, with no drain and no eviction heard", async () => {
    const { host, evicted, open, exit } = hostOf()
    open("a")
    open("b")
    host.discard("a")
    expect(host.terminal("a")).toBeDefined()
    await exit("a", 0)
    host.discard("a")
    expect(host.terminal("a")).toBeUndefined()
    expect(host.draining("a")).toBe(false)
    expect(evicted).toEqual([])
    // A terminal whose program runs stays, and the id can be opened again.
    host.discard("b")
    expect(host.terminal("b")).toBeDefined()
    open("a")
    expect(host.terminal("a")).toBeDefined()
  })

  it("removes nothing it doesn't hold open, and never opens an id twice", () => {
    const { host, open } = hostOf()
    host.remove("nothing")
    expect(host.draining("nothing")).toBe(false)
    open("a")
    const again = host.reserve("a")
    expect(() => again.open(spec, undefined)).toThrow("already open")
    again.done()
  })
})

describe("a terminal host's attach", () => {
  it("asks the caller's check before the terminal's own refusals, and refuses all once shut down", async () => {
    const { host, open, programs } = hostOf()
    open("a")
    const first = host.attach("a", "viewer", { mode: "control" })
    await first.next()
    const refusal = new Error("closed meanwhile")
    // The check comes first: no ALREADY_ATTACHED for an attach it refuses.
    await expect(
      host
        .attach(
          "a",
          "viewer",
          { mode: "observe" },
          {
            check: () => {
              throw refusal
            },
          },
        )
        .next(),
    ).rejects.toBe(refusal)
    await first.return(undefined)
    const late = host.attach(
      "a",
      "other",
      { mode: "observe" },
      {
        check: () => {
          throw refusal
        },
      },
    )
    const done = host.shutdown()
    for (const program of programs) program.exit(0)
    await expect(late.next()).rejects.toMatchObject({ code: "CLOSING" })
    await done
  })

  it("ends its stream and its control once aborted after attaching", async () => {
    const { host, open } = hostOf()
    const terminal = open("a")
    const controller = new AbortController()
    const stream = host.attach("a", "viewer", { mode: "control" }, { signal: controller.signal })
    await stream.next()
    await stream.next()
    expect(terminal.controller).toBe("viewer")
    controller.abort()
    expect(terminal.controller).toBeUndefined()
    expect(await stream.next()).toEqual({ value: undefined, done: true })
  })

  it("refuses in order: the caller's check, then the terminal's own", async () => {
    const { host, open } = hostOf()
    open("a")
    const refusal = new Error("closed meanwhile")
    await expect(
      host
        .attach(
          "a",
          "viewer",
          { mode: "observe" },
          {
            check: () => {
              throw refusal
            },
          },
        )
        .next(),
    ).rejects.toBe(refusal)
    const first = host.attach("a", "viewer", { mode: "control" })
    await first.next()
    await expect(host.attach("a", "viewer", { mode: "observe" }).next()).rejects.toMatchObject({
      code: "ALREADY_ATTACHED",
    })
    await expect(host.attach("a", "other", { mode: "control" }).next()).rejects.toMatchObject({
      code: "CONTROL_IN_USE",
    })
    await expect(
      host.attach("nothing", "viewer", { mode: "observe" }).next(),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    await first.return(undefined)
  })

  it("attaches nothing given up before its turn, letting go of control held without one", async () => {
    const { host, programs } = hostOf()
    const place = host.reserve("a")
    const terminal = place.open(spec, "creator")
    place.done()
    const controller = new AbortController()
    const given = host.attach("a", "creator", { mode: "control" }, { signal: controller.signal })
    const result = given.next()
    controller.abort()
    expect(await result).toEqual({ value: undefined, done: true })
    expect(terminal.controller).toBeUndefined()
    let released = false
    const late = host.attach("a", "viewer", { mode: "observe" }, { released: () => released })
    const pending = late.next()
    released = true
    expect(await pending).toEqual({ value: undefined, done: true })
    expect(terminal.attached).toBe(0)
    expect(programs).toHaveLength(1)
  })
})

describe("a terminal host's restart", () => {
  const restartOf = async (
    host: ReturnType<typeof hostOf>["host"],
    o: { owner?: string; check?: () => void } = {},
  ) =>
    host.restart("a", o.owner ?? "owner", {
      check: o.check ?? (() => {}),
      prepare: async () => (restart) => {
        restart(spec, o.owner ?? "owner", () => {})
        return "restarted"
      },
    })

  it("refuses a running terminal, another restart under way, and another's control", async () => {
    const { host, open, exit } = hostOf()
    const terminal = open("a")
    await expect(restartOf(host)).rejects.toMatchObject({ code: "CONFLICT" })
    terminal.attach("someone", { mode: "control" })
    await exit("a", 0)
    await expect(restartOf(host)).rejects.toMatchObject({ code: "CONTROL_IN_USE" })
    terminal.release("someone")
    let go!: () => void
    const waiting = host.restart<void>("a", "owner", {
      check: () => {},
      prepare: () =>
        new Promise((resolve) => {
          go = () => resolve((restart) => restart(spec, "owner", () => {}))
        }),
    })
    await expect(restartOf(host)).rejects.toMatchObject({ code: "CONFLICT" })
    go()
    await waiting
    expect(terminal.exit).toBeNull()
  })

  it("refuses a terminal a close ended, which stays closing for good", async () => {
    const { host, programs, open } = hostOf()
    const terminal = open("a")
    const closing = host.terminate("a")
    programs[0]!.exit(0)
    await closing
    await expect(restartOf(host)).rejects.toMatchObject({ code: "CLOSING" })
    expect(terminal.run).toBe(1)
    expect(host.closing("a")).toBe(true)
  })

  it("asks the caller's check before and in its step, and runs the step's restart", async () => {
    const { host, open, exit } = hostOf()
    const terminal = open("a")
    await exit("a", 0)
    let closed = false
    const check = () => {
      if (closed) throw new Error("closed meanwhile")
    }
    let go!: () => void
    const waiting = host.restart<void>("a", "owner", {
      check,
      prepare: () =>
        new Promise((resolve) => {
          go = () => resolve((restart) => restart(spec, "owner", () => {}))
        }),
    })
    closed = true
    go()
    await expect(waiting).rejects.toThrow("closed meanwhile")
    expect(terminal.exit).not.toBeNull()
    closed = false
    expect(await restartOf(host, { check })).toBe("restarted")
    expect(terminal.exit).toBeNull()
  })
})

describe("a terminal host's shutdown", () => {
  it("ends every program, then lets every terminal go", async () => {
    const { host, programs, open } = hostOf()
    open("a")
    open("b")
    const done = host.shutdown()
    for (const program of programs) program.exit(0)
    await done
    expect(host.terminal("a")).toBeUndefined()
    expect(host.terminal("b")).toBeUndefined()
    // Removing during shutdown keeps nothing to drain.
    host.remove("a")
    expect(host.draining("a")).toBe(false)
    expect(() => host.reserve("c")).toThrow(expect.objectContaining({ code: "CLOSING" }))
  })
})

// What an agent left in its terminal's scope, as the scope lists it: real processes of the
// test's own, each in a group of its own, that ignore the hangup.
describe.skipIf(process.platform !== "linux")("what agents left in a terminal's scope", () => {
  const left = () => {
    const child = spawn(
      process.execPath,
      ["-e", 'process.on("SIGHUP", () => {}); console.log("up"); setInterval(() => {}, 1000)'],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    )
    onTestFinished(() => void child.kill("SIGKILL"))
    const gone = new Promise<NodeJS.Signals | null>((end) =>
      child.once("exit", (_code, signal) => end(signal)),
    )
    return new Promise<{ pid: number; gone: typeof gone }>((resolve) => {
      child.stdout.once("data", () => resolve({ pid: child.pid!, gone }))
    })
  }

  // A host whose terminals' scopes hold `members`, by their pids.
  const scopedHost = (members: number[], apart: TerminalHostOptions["apart"] = undefined) => {
    const programs: Program[] = []
    const native: NativeSpawn = (...args) => {
      const program = nativeStandIn({ pid: shellPid })
      programs.push(program)
      return program.spawn(...args)
    }
    const host = createTerminalHost({
      eventBytes: () => 1,
      limits: {
        historyBytes: 1024 * 1024,
        subscriberBytes: 4 * 1024 * 1024,
        ackWindowBytes: 256 * 1024,
        snapshotBytes: 32 * 1024 * 1024,
        maxTerminals: 8,
        maxRetained: 8,
      },
      scrollback: 1000,
      kill: { graceMs: 1000, treeGraceMs: 300, shutdownTreesMs: 1000, shutdownTreeGraceMs: 100 },
      trees: noTrees,
      ...(apart && { apart }),
      pty: {
        native,
        platform: "linux",
        scopes: {
          active: () => true,
          contain: () => ({
            cause: () => undefined,
            weigh: () => Promise.resolve(),
            members: () => Promise.resolve(members.map((pid) => ({ pid }))),
            exited: () => Promise.resolve(),
          }),
        },
      },
    })
    onTestFinished(async () => {
      const done = host.shutdown()
      for (const program of programs) program.exit(0)
      await done
    })
    const place = host.reserve("a")
    const terminal = place.open(spec, undefined)
    place.done()
    return { host, programs, terminal }
  }

  it("ends them as a terminal whose shell exited by itself closes", async () => {
    const members: number[] = []
    const { host, programs, terminal } = scopedHost(members)
    terminal.pty.agentStarted(undefined)
    const tool = await left()
    members.push(tool.pid)
    programs[0]!.exit(0)
    await terminal.exited
    await host.terminate("a")
    expect(await tool.gone).toBe("SIGTERM")
  })

  it("ends them for each run an agent had, before a restart too, and leaves what the harness runs apart", async () => {
    const members: number[] = []
    let service: ApartProcess | undefined
    const { host, programs, terminal } = scopedHost(members, () =>
      Promise.resolve(service ? [service] : []),
    )
    terminal.pty.agentStarted(undefined)
    const [tool, kept] = await Promise.all([left(), left()])
    members.push(tool.pid, kept.pid)
    const stat = readFileSync(`/proc/${kept.pid}/stat`, "utf8")
    service = { pid: kept.pid, start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]! }
    programs[0]!.exit(0)
    await terminal.exited
    await host.restart("a", "owner", {
      check: () => {},
      prepare: async () => (restart) => restart(spec, "owner", () => {}),
    })
    expect(terminal.earlier).toHaveLength(1)
    const closing = host.terminate("a")
    programs[1]!.exit(0)
    await closing
    expect(await tool.gone).toBe("SIGTERM")
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(() => process.kill(kept.pid, 0)).not.toThrow()
  })

  it("ends them as the host shuts down", async () => {
    const members: number[] = []
    const { host, programs, terminal } = scopedHost(members)
    terminal.pty.agentStarted(undefined)
    const tool = await left()
    members.push(tool.pid)
    programs[0]!.exit(0)
    await terminal.exited
    await host.shutdown()
    expect(await tool.gone).toBe("SIGTERM")
  })

  it("leaves them where no agent ran", async () => {
    const members: number[] = []
    const { host, programs, terminal } = scopedHost(members)
    const tool = await left()
    members.push(tool.pid)
    programs[0]!.exit(0)
    await terminal.exited
    await host.terminate("a")
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(() => process.kill(tool.pid, 0)).not.toThrow()
  })
})
