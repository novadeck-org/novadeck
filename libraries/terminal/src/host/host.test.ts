import { describe, expect, it, onTestFinished } from "vitest"

import type { TerminalEvent } from "../contract.js"
import type { NativeSpawn, ProcessTrees } from "../pty/pty.js"
import { nativeStandIn } from "../testing.js"
import { createTerminalHost, type TerminalHostOptions } from "./host.js"
import type { RunSpec } from "./terminal.js"

type Program = ReturnType<typeof nativeStandIn>

const spec: RunSpec = { file: "shell", args: [], cwd: "/", env: {}, cols: 20, rows: 4 }

const noTrees: ProcessTrees = { read: async () => [], end: async () => {} }

/** A host over stand-in programs, one for each terminal it opens, in turn. */
const hostOf = (limits: Partial<TerminalHostOptions["limits"]> = {}) => {
  const programs: Program[] = []
  const native: NativeSpawn = (...args) => {
    const program = nativeStandIn()
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

  it("keeps an exited terminal that is read or kept, and lets it go once it isn't", async () => {
    const { host, evicted, open, exit } = hostOf({ maxRetained: 0 })
    const read = open("a")
    read.attach("viewer", { mode: "observe" })
    const kept = open("b")
    const keep = host.keep("b")
    await exit("a", 0)
    await exit("b", 1)
    expect(evicted).toEqual([])
    read.release("viewer")
    keep()
    expect(kept.exit).not.toBeNull()
    host.evict()
    expect(evicted).toEqual(["a", "b"])
  })
})

describe("a terminal host's close", () => {
  it("ends the program, then keeps the closed terminal for its viewers until they're done", async () => {
    const { host, programs, open } = hostOf()
    const terminal = open("a")
    const viewer = terminal.attach("viewer", { mode: "observe" })
    await viewer.next()
    const closing = host.terminate("a")
    expect(host.closing("a")).toBe(true)
    // The stand-in exits on its kill's grace; its exit is handled in turn.
    programs[0]!.exit(0)
    await closing
    host.remove("a")
    expect(host.draining("a")).toBe(true)
    expect(host.terminal("a")).toBe(terminal)
    expect(await viewer.next()).toMatchObject({ type: "exited" })
    terminal.release("viewer")
    host.settle("a")
    expect(host.draining("a")).toBe(false)
    expect(host.terminal("a")).toBeUndefined()
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
    const keep = host.keep("a")
    host.remove("a")
    expect(host.draining("a")).toBe(true)
    keep()
    expect(host.draining("a")).toBe(false)
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
