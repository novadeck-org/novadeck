import type { Screen } from "@novadeck/emulator/headless"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import type { TerminalEvent } from "../contract.js"
import type { NativeSpawn } from "../pty/pty.js"
import { nativeStandIn } from "../testing.js"
import { createTerminal, type Attachment, type RunSpec, type TerminalOptions } from "./terminal.js"

// Each event as a transport would send it, in an envelope naming its terminal.
const eventBytes = (event: TerminalEvent) =>
  Buffer.byteLength(JSON.stringify({ ...event, terminalId: "terminal" }))

const limits = {
  historyBytes: 1024 * 1024,
  subscriberBytes: 4 * 1024 * 1024,
  ackWindowBytes: 256 * 1024,
  snapshotBytes: 32 * 1024 * 1024,
}

const specOf = (cols = 20, rows = 4): RunSpec => ({
  file: "shell",
  args: [],
  cwd: "/",
  env: {},
  cols,
  rows,
})

type Program = ReturnType<typeof nativeStandIn>

/**
 * A terminal over stand-in programs: the first run's, then each restart's in turn. Each
 * draws what `draw` gives it and exits as `exit` says.
 */
const terminalOf = (
  o: { cols?: number; rows?: number; runs?: number } & Partial<
    Pick<TerminalOptions, "limits" | "controller">
  > = {},
) => {
  const runs = Array.from({ length: o.runs ?? 1 }, () => nativeStandIn())
  let spawned = 0
  const native: NativeSpawn = (...args) => {
    const run = runs[spawned]
    spawned += 1
    if (!run) throw new Error("No program to start")
    return run.spawn(...args)
  }
  const terminal = createTerminal({
    eventBytes,
    limits: o.limits ?? limits,
    spec: specOf(o.cols, o.rows),
    scrollback: 1000,
    controller: o.controller,
    pty: { native, platform: "linux" },
  })
  onTestFinished(() => terminal.dispose())
  const program = runs[0] as Program
  /** Once everything queued so far, draws included, has run. */
  const settled = () => terminal.enqueue(() => {})
  return { terminal, runs: runs as Program[], program, settled }
}

type Hosted = ReturnType<typeof terminalOf>

/** Everything an attachment has ready now, acknowledging each as a reader would. */
const drain = async (
  terminal: Hosted["terminal"],
  owner: string,
  attachment: Attachment,
  count: number,
) => {
  const events: TerminalEvent[] = []
  for (let index = 0; index < count; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- Read in order.
    const event = await attachment.next()
    if (event === undefined) break
    events.push(event)
    terminal.ack(owner, event.sequence)
  }
  return events
}

const text = (screen: Screen) =>
  Array.from({ length: screen.rows }, (_, index) =>
    screen.buffer.active.getLine(screen.buffer.active.baseY + index)?.translateToString(true),
  ).join("\n")

const shown = (event: TerminalEvent) => (event.type === "output" ? event.data : event.type)

describe("a terminal's output", () => {
  it("is drawn, then sent in events of at most 4,096 characters", async () => {
    const { terminal, program, settled } = terminalOf()
    const viewer = terminal.attach("viewer", { mode: "observe" })
    await viewer.next()
    program.draw("a".repeat(10_000))
    await settled()
    const events = await drain(terminal, "viewer", viewer, 3)
    expect(events.map((event) => shown(event).length)).toEqual([4096, 4096, 1808])
  })

  it("joins what is read while a draw waits, and never splits a surrogate pair", async () => {
    const { terminal, program, settled } = terminalOf()
    const viewer = terminal.attach("viewer", { mode: "observe" })
    await viewer.next()
    // 4,095 characters, then an emoji whose pair would straddle the chunk's end.
    program.draw("a".repeat(4095))
    program.draw("😀")
    program.draw("b")
    await settled()
    const events = await drain(terminal, "viewer", viewer, 2)
    expect(events.map(shown)).toEqual(["a".repeat(4095), "😀b"])
  })

  it("tells its listeners a batch is on the screen before sending its events", async () => {
    const { terminal, program, settled } = terminalOf()
    const seen: unknown[] = []
    terminal.on("drawn", () => {
      // No event yet: a cursor at 1 is past the last.
      let code: unknown
      try {
        terminal.attach("probe", { after: 1, mode: "observe" })
      } catch (error) {
        code = (error as { code?: string }).code
      }
      seen.push([text(terminal.screen).trim(), code])
    })
    program.draw("hello")
    await settled()
    expect(seen).toEqual([["hello", "INVALID_CURSOR"]])
    const viewer = terminal.attach("viewer", { after: 0, mode: "observe" })
    expect(await viewer.next()).toEqual({ type: "output", data: "hello", sequence: 1 })
  })

  it("is drawn in order with a resize queued between, never joining a draw ahead of it", async () => {
    const { terminal, program, settled } = terminalOf()
    const viewer = terminal.attach("viewer", { mode: "observe" })
    await viewer.next()
    program.draw("DRAW-A")
    terminal.resize(100, 30)
    program.draw("DRAW-B")
    // Read while a draw waits, with nothing between, it still joins it.
    program.draw("DRAW-C")
    await settled()
    const events = await drain(terminal, "viewer", viewer, 3)
    expect(events.map(shown)).toEqual(["DRAW-A", "resized", "DRAW-BDRAW-C"])
    expect(program.calls).toContain("resize 100x30")
  })

  it("tells its listeners a size took effect before sending it", async () => {
    const { terminal, settled } = terminalOf()
    const viewer = terminal.attach("viewer", { mode: "observe" })
    await viewer.next()
    const seen: unknown[] = []
    terminal.on("resized", (size) => seen.push([size, terminal.screen.cols]))
    terminal.resize(30, 5)
    expect(seen).toEqual([])
    await settled()
    expect(seen).toEqual([[{ cols: 30, rows: 5 }, 30]])
    expect(await viewer.next()).toEqual({ type: "resized", cols: 30, rows: 5, sequence: 1 })
  })

  it("pauses its program while much of it waits, and resumes it once drawn", async () => {
    const { program, settled } = terminalOf()
    program.draw("a".repeat(200 * 1024))
    program.draw("b".repeat(100 * 1024))
    expect(program.calls).toContain("pause")
    await settled()
    expect(program.calls.at(-1)).toBe("resume")
  })

  it("drops what an earlier run left queued", async () => {
    const { terminal, runs, settled } = terminalOf({ runs: 2 })
    const [first, second] = runs as [Program, Program]
    first.exit(0)
    await settled()
    void terminal.enqueue(() => terminal.restart(specOf(), undefined, () => {}))
    // Read after the restart was queued, it comes from a run that is gone.
    first.draw("OLD")
    await settled()
    second.draw("NEW")
    await settled()
    expect(text(terminal.screen)).toContain("NEW")
    expect(text(terminal.screen)).not.toContain("OLD")
  })

  it("reports the title, the prompt's directory and a full reset, with the run they came from", async () => {
    const { terminal, program, settled } = terminalOf()
    const seen: unknown[] = []
    terminal.on("title", (title, run) => seen.push(["title", title, run === terminal.pty]))
    terminal.on("cwd", (cwd, run) => seen.push(["cwd", cwd, run === terminal.pty]))
    terminal.on("reset", () => seen.push(["reset"]))
    program.draw("\u001b]0;Hello\u0007")
    program.draw("\u001b]7;file:///tmp/here\u001b\\")
    program.draw('\u001b]9;9;"/srv/there"\u001b\\')
    program.draw("\u001bc")
    await settled()
    expect(seen).toEqual([
      ["title", "Hello", true],
      ["cwd", "/tmp/here", true],
      ["cwd", "/srv/there", true],
      ["reset"],
    ])
  })

  it("answers the screen's device queries, until its exit is queued", async () => {
    const { program, settled } = terminalOf()
    const writes = () => program.calls.filter((call) => call.startsWith("write"))
    program.draw("\u001b[6n")
    await settled()
    expect(writes()).toEqual(["write \u001b[1;1R"])
    program.exit(0)
    program.draw("\u001b[6n")
    await settled()
    expect(writes()).toHaveLength(1)
  })
})

describe("a terminal's hold", () => {
  const budget = { inputMs: 5_000, sizeMs: 10_000 }
  const live = () => true
  const writes = (program: Program) =>
    program.calls.filter((call) => call.startsWith("write")).map((call) => call.slice(6))

  it("holds the person's keys until released, writing the terminal's reports at once", async () => {
    const { terminal, program } = terminalOf()
    const keys: string[] = []
    terminal.on("keys", (typed) => keys.push(typed))
    const hold = terminal.hold(budget, live)
    expect(hold.holding()).toBe(true)
    terminal.input("a\x1b[12;40Rb")
    terminal.input("c")
    // The cursor report goes; the keys wait, and count as typed.
    expect(writes(program)).toEqual(["\x1b[12;40R"])
    expect(keys).toEqual(["ab", "c"])
    // The holder's own writes are never held.
    terminal.type("ring")
    hold.release()
    expect(writes(program)).toEqual(["\x1b[12;40R", "ring", "abc"])
    expect(hold.holding()).toBe(false)
    terminal.input("d")
    expect(writes(program).at(-1)).toBe("d")
    expect(keys).toEqual(["ab", "c", "d"])
  })

  it("counts a deferred hold's keys only once delivered, dropping the mouse's and what's discarded", async () => {
    const { terminal, program, settled } = terminalOf()
    // A TUI that tracks the mouse in SGR.
    program.draw("\x1b[?1003h\x1b[?1006h")
    await settled()
    const keys: string[] = []
    terminal.on("keys", (typed) => keys.push(typed))
    const first = terminal.hold({ ...budget, deferred: true }, live)
    terminal.input("\x1b[<64;5;5Mx")
    expect(keys).toEqual([])
    first.discard()
    first.release()
    expect(writes(program)).toEqual([])
    first.settle()
    const second = terminal.hold({ ...budget, deferred: true }, live)
    terminal.input("y")
    second.release()
    expect(keys).toEqual(["y"])
    expect(writes(program)).toEqual(["y"])
  })

  it("tells the keys before writing them", () => {
    const { terminal, program } = terminalOf()
    const seen: string[] = []
    terminal.on("keys", (typed) => seen.push(`keys ${typed}, written ${writes(program).length}`))
    terminal.input("a")
    const hold = terminal.hold({ ...budget, deferred: true }, live)
    terminal.input("b")
    hold.release()
    expect(seen).toEqual(["keys a, written 0", "keys b, written 1"])
  })

  it("writes nothing, and applies no size, once its terminal stops running", () => {
    const { terminal, program } = terminalOf({ controller: "window" })
    let running = true
    const hold = terminal.hold(budget, () => running)
    terminal.input("k")
    terminal.resize(30, 5, "window")
    running = false
    expect(hold.holding()).toBe(false)
    hold.settle()
    expect(writes(program)).toEqual([])
    expect(program.calls).not.toContain("resize 30x5")
  })

  it("applies no held size for the same window attached anew, which asks its own", () => {
    const { terminal, program } = terminalOf({ controller: "window" })
    terminal.attach("window", { mode: "control" })
    const hold = terminal.hold(budget, live)
    terminal.resize(30, 5, "window")
    terminal.release("window")
    terminal.attach("window", { mode: "control" })
    hold.settle()
    expect(program.calls).not.toContain("resize 30x5")
  })

  it("refuses a second hold while one holds the input, and holds nothing where the terminal doesn't run", () => {
    const { terminal } = terminalOf()
    const first = terminal.hold(budget, live)
    expect(terminal.hold(budget, live).holding()).toBe(false)
    first.settle()
    expect(terminal.hold(budget, () => false).holding()).toBe(false)
  })

  it("lets the keys go at its input cap, and the sizes at its size cap", async () => {
    const { terminal, program, settled } = terminalOf({ controller: "window" })
    const hold = terminal.hold({ inputMs: 20, sizeMs: 1_000 }, live)
    terminal.input("k")
    terminal.resize(30, 5, "window")
    await vi.waitFor(() => expect(writes(program)).toEqual(["k"]))
    expect(program.calls).not.toContain("resize 30x5")
    await vi.waitFor(() => expect(program.calls).toContain("resize 30x5"), { timeout: 3_000 })
    await settled()
    expect(terminal.screen.cols).toBe(30)
    expect(hold.holding()).toBe(false)
  })

  it("hands the sizes a lapsed hold left to the next, which applies them as it settles", async () => {
    const { terminal, program, settled } = terminalOf({ controller: "window" })
    const first = terminal.hold(budget, live)
    terminal.resize(30, 5, "window")
    first.release()
    const second = terminal.hold(budget, live)
    // The first's late settle changes nothing: the second holds them now.
    first.settle()
    expect(program.calls).not.toContain("resize 30x5")
    expect(terminal.resizedAt).toBe(0)
    second.settle()
    expect(program.calls).toContain("resize 30x5")
    expect(terminal.resizedAt).toBeGreaterThan(0)
    await settled()
    expect(terminal.screen.cols).toBe(30)
  })

  it("keeps the sizes waiting for the deadline the hold before set, past an early settle", async () => {
    const { terminal, program } = terminalOf({ controller: "window" })
    const first = terminal.hold(budget, live)
    terminal.resize(30, 5, "window")
    first.settleAfter(80)
    const second = terminal.hold(budget, live)
    second.settle()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(program.calls).not.toContain("resize 30x5")
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(program.calls).toContain("resize 30x5")
  })

  it("applies a held size only for the attachment still in control", async () => {
    const { terminal, program } = terminalOf({ controller: "window" })
    terminal.attach("window", { mode: "control" })
    const hold = terminal.hold(budget, live)
    terminal.resize(30, 5, "window")
    // Another window takes control meanwhile, and is told the size in force.
    terminal.release("window")
    terminal.attach("other", { mode: "control" })
    hold.settle()
    expect(program.calls).not.toContain("resize 30x5")
  })
})

describe("a terminal's exit", () => {
  it("is told to its listeners, then sent, then ends its attachments, then is done", async () => {
    const { terminal, program, settled } = terminalOf()
    const viewer = terminal.attach("viewer", { mode: "observe" })
    await viewer.next()
    const seen: string[] = []
    terminal.on("exit", (exit) => seen.push(`exit ${exit.code}, exiting ${terminal.exiting}`))
    terminal.on("exited", () => seen.push(`exited, ${terminal.attached} attached`))
    void terminal.exited.then(() => seen.push("promise"))
    program.exit(3)
    expect(terminal.exiting).toBe(true)
    await settled()
    await terminal.exited
    expect(seen).toEqual(["exit 3, exiting true", "exited, 1 attached", "promise"])
    expect(await drain(terminal, "viewer", viewer, 3)).toMatchObject([
      { type: "exited", exit: { code: 3, signal: null } },
    ])
    expect(await viewer.next()).toBeUndefined()
  })

  it("is reported once, with how long the run ran", async () => {
    const { terminal, program, settled } = terminalOf()
    const exits: unknown[] = []
    terminal.on("exit", (exit) => exits.push(exit))
    program.exit(0)
    program.exit(1)
    await settled()
    expect(exits).toEqual([{ code: 0, signal: null, ranMs: expect.any(Number) }])
  })

  it("ends at once an attachment made after it, its snapshot read", async () => {
    const { terminal, program, settled } = terminalOf()
    program.exit(0)
    await settled()
    const attachment = terminal.attach("viewer", { mode: "observe" })
    expect(await drain(terminal, "viewer", attachment, 2)).toMatchObject([
      { type: "snapshot", exit: { code: 0 } },
    ])
  })
})

describe("a terminal's restart", () => {
  it("starts a new run in one step: attachments end, the ring starts over, control is set", async () => {
    const { terminal, runs, settled } = terminalOf({ runs: 2, controller: "creator" })
    const [first, second] = runs as [Program, Program]
    first.draw("one")
    first.exit(0)
    await settled()
    const before = terminal.attach("viewer", { mode: "observe" })
    const earlier = terminal.pty
    const swapped: unknown[] = []
    await terminal.enqueue(() =>
      terminal.restart(specOf(30, 5), "restarter", () =>
        swapped.push([terminal.pty !== earlier, terminal.exiting, terminal.attached]),
      ),
    )
    expect(swapped).toEqual([[true, false, 0]])
    expect(terminal.controller).toBe("restarter")
    expect(await drain(terminal, "viewer", before, 3)).toEqual([])
    // Sequences 1 and 2 were the first run's and 3 was skipped: a cursor at 2 gets a snapshot.
    const again = terminal.attach("viewer", { after: 2, mode: "observe" })
    expect(await again.next()).toMatchObject({
      type: "snapshot",
      sequence: 3,
      cols: 30,
      rows: 5,
      exit: null,
    })
    second.draw("two")
    await settled()
    expect(await again.next()).toEqual({ type: "output", data: "two", sequence: 4 })
  })

  it("refuses while the run still goes, which nothing would end then", async () => {
    const { terminal, runs } = terminalOf({ runs: 2 })
    expect(() => terminal.restart(specOf(), undefined, () => {})).toThrow(
      "Only an exited terminal restarts.",
    )
    expect(terminal.pty.exited).toBe(false)
    expect(runs[1]!.calls).toEqual([])
  })

  it("leaves the earlier run as it was when the new one can't start", async () => {
    const { terminal, program, settled } = terminalOf({ controller: "creator" })
    program.exit(0)
    await settled()
    const earlier = terminal.pty
    let swapped = false
    await expect(
      terminal.enqueue(() =>
        terminal.restart(specOf(), "restarter", () => {
          swapped = true
        }),
      ),
    ).rejects.toMatchObject({ code: "SPAWN_FAILED" })
    expect(swapped).toBe(false)
    expect(terminal.pty).toBe(earlier)
    expect(terminal.exiting).toBe(true)
    expect(terminal.controller).toBe("creator")
  })
})

describe("a terminal's events", () => {
  it("are sequenced, and replayed after a cursor the ring still holds", async () => {
    const { terminal, program, settled } = terminalOf()
    program.draw("one")
    await settled()
    program.draw("two")
    await settled()
    terminal.resize(30, 5)
    await settled()
    const attachment = terminal.attach("viewer", { after: 1, mode: "observe" })
    expect(await drain(terminal, "viewer", attachment, 2)).toEqual([
      { type: "output", data: "two", sequence: 2 },
      { type: "resized", cols: 30, rows: 5, sequence: 3 },
    ])
    program.draw("three")
    await settled()
    expect(await attachment.next()).toEqual({ type: "output", data: "three", sequence: 4 })
  })

  it("leave the ring past its bytes, so a cursor before them gets a snapshot", async () => {
    const big = "x".repeat(400)
    const bytes = eventBytes({ type: "output", data: big, sequence: 1 })
    const { terminal, program, settled } = terminalOf({
      limits: { ...limits, historyBytes: bytes * 2 },
    })
    for (let index = 0; index < 4; index += 1) {
      program.draw(big)
      // eslint-disable-next-line no-await-in-loop -- One event a draw.
      await settled()
    }
    // Events 3 and 4 remain: a cursor at 2 still replays, one at 1 can't.
    const replayed = terminal.attach("late", { after: 2, mode: "observe" })
    expect((await drain(terminal, "late", replayed, 2)).map((event) => event.sequence)).toEqual([
      3, 4,
    ])
    const behind = terminal.attach("behind", { after: 1, mode: "observe" })
    expect(await behind.next()).toMatchObject({ type: "snapshot", sequence: 4 })
  })

  it("refuse a cursor past the last event, or not a count", async () => {
    const { terminal, program, settled } = terminalOf()
    program.draw("one")
    await settled()
    for (const after of [2, -1, 1.5])
      expect(() => terminal.attach("viewer", { after, mode: "observe" })).toThrow(
        expect.objectContaining({ code: "INVALID_CURSOR" }),
      )
    expect(terminal.attached).toBe(0)
    expect(() => terminal.ack("viewer", -1)).toThrow(
      expect.objectContaining({ code: "INVALID_CURSOR" }),
    )
  })
})

describe("a terminal's attachments", () => {
  it("have one controller and any number of observers", () => {
    const { terminal } = terminalOf({ controller: "creator" })
    terminal.attach("creator", { mode: "control" })
    expect(() => terminal.attach("other", { mode: "control" })).toThrow(
      expect.objectContaining({ code: "CONTROL_IN_USE" }),
    )
    terminal.attach("other", { mode: "observe" })
    expect(() => terminal.attach("other", { mode: "observe" })).toThrow(
      expect.objectContaining({ code: "ALREADY_ATTACHED" }),
    )
    expect(terminal.attached).toBe(2)
    terminal.release("creator")
    expect(terminal.controller).toBeUndefined()
    expect(terminal.attached).toBe(1)
  })

  it("give up control where the controller attaches anew only to observe", () => {
    const { terminal } = terminalOf({ controller: "creator" })
    terminal.attach("creator", { mode: "observe" })
    expect(terminal.controller).toBeUndefined()
  })

  it("let control go when an attach is given up before it attached, and only then", () => {
    const { terminal } = terminalOf({ controller: "creator" })
    terminal.forgo("creator")
    expect(terminal.controller).toBeUndefined()
    const { terminal: held } = terminalOf({ controller: "creator" })
    held.attach("creator", { mode: "control" })
    held.forgo("creator")
    expect(held.controller).toBe("creator")
  })

  it("lose control, and their place, as one fails behind", async () => {
    const { terminal, program, settled } = terminalOf({
      controller: "creator",
      limits: { ...limits, subscriberBytes: 1024, ackWindowBytes: 256 },
    })
    const attachment = terminal.attach("creator", { mode: "control" })
    await attachment.next()
    for (let index = 0; index < 8; index += 1) {
      program.draw("x".repeat(200))
      // eslint-disable-next-line no-await-in-loop -- One event a draw.
      await settled()
    }
    await expect(drain(terminal, "creator", attachment, 10)).rejects.toMatchObject({
      code: "SLOW_CONSUMER",
    })
    expect(terminal.controller).toBeUndefined()
    expect(terminal.attachment("creator")).toBeUndefined()
  })

  it("are told apart from a later one of the same owner", () => {
    const { terminal } = terminalOf()
    const first = terminal.attach("viewer", { mode: "observe" })
    expect(terminal.attachment("viewer")).toBe(first)
    terminal.release("viewer")
    const second = terminal.attach("viewer", { mode: "observe" })
    expect(terminal.attachment("viewer")).toBe(second)
    expect(second).not.toBe(first)
  })

  it("all end, with all control, as the host stops", () => {
    const { terminal } = terminalOf({ controller: "creator" })
    terminal.attach("creator", { mode: "control" })
    terminal.attach("other", { mode: "observe" })
    terminal.end()
    expect(terminal.attached).toBe(0)
    expect(terminal.controller).toBeUndefined()
  })
})

describe("a terminal's snapshot", () => {
  const snapshotOf = async ({ terminal }: Hosted) => {
    const attachment = terminal.attach("snapshot", { mode: "observe" })
    const event = await attachment.next()
    terminal.release("snapshot")
    if (event?.type !== "snapshot")
      throw new Error(`Expected a snapshot, got ${JSON.stringify(event)}`)
    return event
  }
  const sized = (snapshotBytes: number, o: { cols?: number; rows?: number } = {}) =>
    terminalOf({ ...o, limits: { ...limits, snapshotBytes } })
  /** A fresh terminal's screen once `data` is drawn on it, as a reloaded client's would be. */
  const restoredFrom = async (data: string) => {
    const restored = terminalOf()
    restored.program.draw(data)
    await restored.settled()
    return restored.terminal.screen
  }

  it("recovers a fully colored ordinary terminal whose retained screen exceeds the live queue budget", async () => {
    const hosted = sized(32 * 1024 * 1024, { cols: 120, rows: 24 })
    const line = Array.from(
      { length: 120 },
      (_, x) =>
        `\u001b[38;2;${x % 256};${(x * 3) % 256};${(x * 7) % 256};48;2;${(x * 11) % 256};${(x * 13) % 256};${(x * 17) % 256}mX`,
    ).join("")
    hosted.program.draw((line + "\r\n").repeat(1024))
    await hosted.settled()
    expect(eventBytes(await snapshotOf(hosted))).toBeGreaterThan(4 * 1024 * 1024)
  })

  it("trims old scrollback to fit the allowance while preserving the visible screen and colors", async () => {
    const budget = 1024
    const full = sized(1024 * 1024)
    const bounded = sized(budget)
    const lines = Array.from(
      { length: 100 },
      (_, index) => `\u001b[38;2;${index};3;7mLINE_${index}\r\n`,
    ).join("")
    for (const hosted of [full, bounded]) {
      hosted.program.draw(lines + "\u001b[31mVISIBLE")
      // eslint-disable-next-line no-await-in-loop -- Each drawn before it is read.
      await hosted.settled()
    }
    expect(eventBytes(await snapshotOf(full))).toBeGreaterThan(budget)
    const event = await snapshotOf(bounded)
    expect(eventBytes(event)).toBeLessThanOrEqual(budget)
    expect(event.data).not.toContain("LINE_0")
    expect(event).toMatchObject({ sequence: 1, cols: 20, rows: 4 })
    const restored = await restoredFrom(event.data)
    const screen = bounded.terminal.screen
    expect(text(restored)).toBe(text(screen))
    const cell = (of: Screen) =>
      of.buffer.active.getLine(of.buffer.active.baseY + of.rows - 1)!.getCell(0)!
    expect(cell(restored).getFgColor()).toBe(cell(screen).getFgColor())
  })

  it("reports an oversized visible viewport instead of silently removing visible cells", async () => {
    const hosted = sized(1)
    hosted.program.draw("\u001b[31mVISIBLE")
    await hosted.settled()
    expect(() => hosted.terminal.attach("viewer", { mode: "observe" })).toThrow(
      expect.objectContaining({ code: "SNAPSHOT_TOO_LARGE" }),
    )
    // The attach left nothing behind, so the same owner may try again.
    expect(hosted.terminal.attached).toBe(0)
    expect(text(hosted.terminal.screen)).toContain("VISIBLE")
  })

  it("preserves the active alternate screen when trimming normal scrollback", async () => {
    const hosted = sized(1024)
    const lines = Array.from(
      { length: 100 },
      (_, index) => `\u001b[38;2;${index};3;7mLINE_${index}\r\n`,
    ).join("")
    hosted.program.draw(lines + "\u001b[?1049h\u001b[32mALT_VIEWPORT")
    await hosted.settled()
    const event = await snapshotOf(hosted)
    expect(eventBytes(event)).toBeLessThanOrEqual(1024)
    const restored = await restoredFrom(event.data)
    expect(restored.buffer.active.type).toBe("alternate")
    expect(text(restored)).toBe(text(hosted.terminal.screen))
    expect(text(restored)).toContain("ALT_VIEWPORT")
  })

  it("carries an SGR TUI's mouse encoding to a fresh client, which then reports the mouse as SGR", async () => {
    const hosted = sized(1024 * 1024)
    // A fullscreen TUI: the alternate screen, any motion of the mouse in SGR, and focus.
    hosted.program.draw("\u001b[?1049h\u001b[?1003h\u001b[?1006h\u001b[?1004h> ")
    await hosted.settled()
    const restored = await restoredFrom((await snapshotOf(hosted)).data)
    const sent: string[] = []
    restored.onData((data) => sent.push(data))
    restored.onBinary((data) => sent.push(data))
    // The wheel down over it, as the client's own mouse handling reports it.
    // xterm.js has no public way to press the mouse on a headless terminal.
    const { coreMouseService } = (
      restored as unknown as {
        _core: { coreMouseService: { triggerMouseEvent: (event: object) => boolean } }
      }
    )
      // eslint-disable-next-line no-underscore-dangle -- As above.
      ._core
    coreMouseService.triggerMouseEvent({
      col: 9,
      row: 2,
      x: 0,
      y: 0,
      button: 4,
      action: 1,
      ctrl: false,
      alt: false,
      shift: false,
    })
    expect(sent).toEqual(["\u001b[<65;10;3M"])
  })
})
