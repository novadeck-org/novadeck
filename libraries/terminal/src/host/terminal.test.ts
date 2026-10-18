import {
  createScreen,
  trackMouse,
  type MouseEncoding,
  type Screen,
} from "@novadeck/emulator/headless"
import { describe, expect, it, onTestFinished } from "vitest"

import type { Exit, TerminalEvent } from "../contract.js"
import { createTerminal, type Attachment, type TerminalOptions } from "./terminal.js"

// Each event as a transport would send it, in an envelope naming its terminal.
const eventBytes = (event: TerminalEvent) =>
  Buffer.byteLength(JSON.stringify({ ...event, terminalId: "terminal" }))

const limits = {
  historyBytes: 1024 * 1024,
  subscriberBytes: 4 * 1024 * 1024,
  ackWindowBytes: 256 * 1024,
  snapshotBytes: 32 * 1024 * 1024,
}

const screenOf = (cols = 20, rows = 4) => {
  const screen = createScreen({ cols, rows, scrollback: 1000 })
  onTestFinished(() => screen.dispose())
  return screen
}

const write = (screen: Screen, data: string) =>
  new Promise<void>((resolve) => screen.write(data, resolve))

const text = (screen: Screen) =>
  Array.from({ length: screen.rows }, (_, index) =>
    screen.buffer.active.getLine(screen.buffer.active.baseY + index)?.translateToString(true),
  ).join("\n")

const terminalOf = (
  o: {
    screen?: Screen
    exit?: () => Exit | null
    mouse?: () => MouseEncoding
  } & Partial<Omit<TerminalOptions, "view">> = {},
) => {
  const screen = o.screen ?? screenOf()
  return createTerminal({
    eventBytes,
    limits,
    ...o,
    view: () => ({
      screen,
      cols: screen.cols,
      rows: screen.rows,
      exit: o.exit?.() ?? null,
      mouse: o.mouse?.() ?? "default",
    }),
  })
}

/** Everything an attachment has ready now, acknowledging each as a reader would. */
const drain = async (
  terminal: ReturnType<typeof terminalOf>,
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

const output = (data: string) => ({ type: "output", data }) as const

describe("a terminal's events", () => {
  it("are sequenced, and replayed after a cursor the ring still holds", async () => {
    const terminal = terminalOf()
    terminal.emit(output("one"))
    terminal.emit(output("two"))
    terminal.emit({ type: "resized", cols: 30, rows: 5 })
    const attachment = terminal.attach("viewer", { after: 1, mode: "observe" })
    expect(await drain(terminal, "viewer", attachment, 2)).toEqual([
      { type: "output", data: "two", sequence: 2 },
      { type: "resized", cols: 30, rows: 5, sequence: 3 },
    ])
    terminal.emit(output("three"))
    expect(await attachment.next()).toEqual({ type: "output", data: "three", sequence: 4 })
  })

  it("leave the ring past its bytes, so a cursor before them gets a snapshot", async () => {
    const big = "x".repeat(400)
    const bytes = eventBytes({ ...output(big), sequence: 1 })
    const terminal = terminalOf({ limits: { ...limits, historyBytes: bytes * 2 } })
    for (let index = 0; index < 4; index += 1) terminal.emit(output(big))
    // Events 3 and 4 remain: a cursor at 2 still replays, one at 1 can't.
    const replayed = terminal.attach("late", { after: 2, mode: "observe" })
    expect((await drain(terminal, "late", replayed, 2)).map((event) => event.sequence)).toEqual([
      3, 4,
    ])
    const behind = terminal.attach("behind", { after: 1, mode: "observe" })
    expect(await behind.next()).toMatchObject({ type: "snapshot", sequence: 4 })
  })

  it("refuse a cursor past the last event, or not a count", () => {
    const terminal = terminalOf()
    terminal.emit(output("one"))
    for (const after of [2, -1, 1.5])
      expect(() => terminal.attach("viewer", { after, mode: "observe" })).toThrow(
        expect.objectContaining({ code: "INVALID_CURSOR" }),
      )
    expect(terminal.attached).toBe(0)
    expect(() => terminal.ack("viewer", -1)).toThrow(
      expect.objectContaining({ code: "INVALID_CURSOR" }),
    )
  })

  it("end each attachment once it has read them all, after the exit", async () => {
    const terminal = terminalOf()
    const attachment = terminal.attach("viewer", { mode: "observe" })
    terminal.emit({ type: "exited", exit: { code: 0, signal: null, ranMs: 5 } })
    terminal.finish()
    const events = await drain(terminal, "viewer", attachment, 3)
    expect(events.map((event) => event.type)).toEqual(["snapshot", "exited"])
    expect(await attachment.next()).toBeUndefined()
  })

  it("end at once for an attachment made after the exit, its snapshot read", async () => {
    const terminal = terminalOf({ exit: () => ({ code: 0, signal: null, ranMs: 5 }) })
    const attachment = terminal.attach("viewer", { mode: "observe" })
    expect(await drain(terminal, "viewer", attachment, 2)).toMatchObject([
      { type: "snapshot", exit: { code: 0 } },
    ])
  })

  it("start over on a restart: an earlier cursor gets a snapshot, attachments end", async () => {
    const terminal = terminalOf({ controller: "creator" })
    terminal.emit(output("one"))
    const before = terminal.attach("viewer", { mode: "observe" })
    terminal.restarted("restarter")
    expect(await drain(terminal, "viewer", before, 2)).toEqual([])
    expect(terminal.controller).toBe("restarter")
    expect(terminal.attached).toBe(0)
    // Sequence 2 was skipped, so a cursor at 1 is no longer the ring's.
    const again = terminal.attach("viewer", { after: 1, mode: "observe" })
    expect(await again.next()).toMatchObject({ type: "snapshot", sequence: 2 })
    terminal.emit(output("two"))
    expect(await again.next()).toEqual({ type: "output", data: "two", sequence: 3 })
  })
})

describe("a terminal's attachments", () => {
  it("have one controller and any number of observers", () => {
    const terminal = terminalOf({ controller: "creator" })
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
    const terminal = terminalOf({ controller: "creator" })
    terminal.attach("creator", { mode: "observe" })
    expect(terminal.controller).toBeUndefined()
  })

  it("let control go when an attach is given up before it attached, and only then", () => {
    const terminal = terminalOf({ controller: "creator" })
    terminal.forgo("creator")
    expect(terminal.controller).toBeUndefined()
    const held = terminalOf({ controller: "creator" })
    held.attach("creator", { mode: "control" })
    held.forgo("creator")
    expect(held.controller).toBe("creator")
  })

  it("lose control, and their place, as one fails behind", async () => {
    const terminal = terminalOf({
      controller: "creator",
      limits: { ...limits, subscriberBytes: 1024, ackWindowBytes: 256 },
    })
    const attachment = terminal.attach("creator", { mode: "control" })
    await attachment.next()
    for (let index = 0; index < 8; index += 1) terminal.emit(output("x".repeat(200)))
    await expect(drain(terminal, "creator", attachment, 10)).rejects.toMatchObject({
      code: "SLOW_CONSUMER",
    })
    expect(terminal.controller).toBeUndefined()
    expect(terminal.attachment("creator")).toBeUndefined()
  })

  it("are told apart from a later one of the same owner", () => {
    const terminal = terminalOf()
    const first = terminal.attach("viewer", { mode: "observe" })
    expect(terminal.attachment("viewer")).toBe(first)
    terminal.release("viewer")
    const second = terminal.attach("viewer", { mode: "observe" })
    expect(terminal.attachment("viewer")).toBe(second)
    expect(second).not.toBe(first)
  })

  it("all end, with all control, as the host stops", () => {
    const terminal = terminalOf({ controller: "creator" })
    terminal.attach("creator", { mode: "control" })
    terminal.attach("other", { mode: "observe" })
    terminal.end()
    expect(terminal.attached).toBe(0)
    expect(terminal.controller).toBeUndefined()
  })
})

describe("a terminal's snapshot", () => {
  const snapshotOf = async (screen: Screen, snapshotBytes: number, mouse?: () => MouseEncoding) => {
    const terminal = terminalOf({
      screen,
      limits: { ...limits, snapshotBytes },
      ...(mouse && { mouse }),
    })
    const event = await terminal.attach("viewer", { mode: "observe" }).next()
    if (event?.type !== "snapshot")
      throw new Error(`Expected a snapshot, got ${JSON.stringify(event)}`)
    return event
  }

  it("recovers a fully colored ordinary terminal whose retained screen exceeds the live queue budget", async () => {
    const screen = screenOf(120, 24)
    const line = Array.from(
      { length: 120 },
      (_, x) =>
        `\u001b[38;2;${x % 256};${(x * 3) % 256};${(x * 7) % 256};48;2;${(x * 11) % 256};${(x * 13) % 256};${(x * 17) % 256}mX`,
    ).join("")
    await write(screen, (line + "\r\n").repeat(1024))
    const event = await snapshotOf(screen, 32 * 1024 * 1024)
    expect(eventBytes(event)).toBeGreaterThan(4 * 1024 * 1024)
  })

  it("trims old scrollback to fit the allowance while preserving the visible screen and colors", async () => {
    const screen = screenOf()
    const restored = screenOf()
    const lines = Array.from(
      { length: 100 },
      (_, index) => `\u001b[38;2;${index};3;7mLINE_${index}\r\n`,
    ).join("")
    await write(screen, lines + "\u001b[31mVISIBLE")
    const full = await snapshotOf(screen, 1024 * 1024)
    const budget = 1024
    expect(eventBytes(full)).toBeGreaterThan(budget)
    const bounded = await snapshotOf(screen, budget)
    expect(eventBytes(bounded)).toBeLessThanOrEqual(budget)
    expect(bounded.data).not.toContain("LINE_0")
    expect(bounded).toMatchObject({ sequence: 0, cols: 20, rows: 4 })
    await write(restored, bounded.data)
    expect(text(restored)).toBe(text(screen))
    const cell = (of: Screen) =>
      of.buffer.active.getLine(of.buffer.active.baseY + of.rows - 1)!.getCell(0)!
    expect(cell(restored).getFgColor()).toBe(cell(screen).getFgColor())
  })

  it("reports an oversized visible viewport instead of silently removing visible cells", async () => {
    const screen = screenOf()
    await write(screen, "\u001b[31mVISIBLE")
    const terminal = terminalOf({ screen, limits: { ...limits, snapshotBytes: 1 } })
    expect(() => terminal.attach("viewer", { mode: "observe" })).toThrow(
      expect.objectContaining({ code: "SNAPSHOT_TOO_LARGE" }),
    )
    // The attach left nothing behind, so the same owner may try again.
    expect(terminal.attached).toBe(0)
    expect(text(screen)).toContain("VISIBLE")
  })

  it("preserves the active alternate screen when trimming normal scrollback", async () => {
    const screen = screenOf()
    const restored = screenOf()
    const lines = Array.from(
      { length: 100 },
      (_, index) => `\u001b[38;2;${index};3;7mLINE_${index}\r\n`,
    ).join("")
    await write(screen, lines + "\u001b[?1049h\u001b[32mALT_VIEWPORT")
    const event = await snapshotOf(screen, 1024)
    expect(eventBytes(event)).toBeLessThanOrEqual(1024)
    await write(restored, event.data)
    expect(restored.buffer.active.type).toBe("alternate")
    expect(text(restored)).toBe(text(screen))
    expect(text(restored)).toContain("ALT_VIEWPORT")
  })

  it("carries an SGR TUI's mouse encoding to a fresh client, which then reports the mouse as SGR", async () => {
    const screen = screenOf()
    const encoding = trackMouse(screen)
    // A client's xterm after a reload, as the UI's is.
    const restored = screenOf()
    // A fullscreen TUI: the alternate screen, any motion of the mouse in SGR, and focus.
    await write(screen, "\u001b[?1049h\u001b[?1003h\u001b[?1006h\u001b[?1004h> ")
    const event = await snapshotOf(screen, 1024 * 1024, encoding)
    await write(restored, event.data)
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
