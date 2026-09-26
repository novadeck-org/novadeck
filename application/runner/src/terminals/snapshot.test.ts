import type { TerminalSummary } from "@novadeck/protocol"
import { SerializeAddon } from "@xterm/addon-serialize"
import headless from "@xterm/headless"

import { describe, expect, it } from "../test.js"
import { snapshot } from "./snapshot.js"
import { Subscription } from "./subscription.js"

const { Terminal } = headless
const summary: TerminalSummary = {
  id: "terminal",
  sessionId: "session",
  cwd: "/tmp",
  cols: 20,
  rows: 4,
  status: "running",
  exitCode: null,
}

const text = (terminal: InstanceType<typeof Terminal>) =>
  Array.from({ length: terminal.rows }, (_, index) =>
    terminal.buffer.active.getLine(terminal.buffer.active.baseY + index)?.translateToString(true),
  ).join("\n")

describe("bounded terminal snapshots", () => {
  it("recovers a fully colored ordinary terminal whose retained screen exceeds the live queue budget", async () => {
    const ordinary = { ...summary, cols: 120, rows: 24 }
    const screen = new Terminal({
      cols: ordinary.cols,
      rows: ordinary.rows,
      scrollback: 1000,
      allowProposedApi: true,
    })
    const serializer = new SerializeAddon()
    screen.loadAddon(serializer)
    try {
      const line = Array.from(
        { length: ordinary.cols },
        (_, x) =>
          `\u001b[38;2;${x % 256};${(x * 3) % 256};${(x * 7) % 256};48;2;${(x * 11) % 256};${(x * 13) % 256};${(x * 17) % 256}mX`,
      ).join("")
      await new Promise<void>((resolve) => screen.write((line + "\r\n").repeat(1024), resolve))
      const allowance = 32 * 1024 * 1024
      const event = snapshot(screen, serializer, ordinary, 10, allowance)
      expect(Buffer.byteLength(JSON.stringify(event))).toBeGreaterThan(4 * 1024 * 1024)
      const subscription = new Subscription(
        "observe",
        4 * 1024 * 1024,
        256 * 1024,
        () => {},
        allowance,
      )
      subscription.push(event)
      expect(await subscription.next()).toEqual(event)
      subscription.cancel()
    } finally {
      screen.dispose()
    }
  })

  it("trims old scrollback to fit the allowance while preserving the visible screen and colors", async () => {
    const screen = new Terminal({
      cols: summary.cols,
      rows: summary.rows,
      scrollback: 1000,
      allowProposedApi: true,
    })
    const serializer = new SerializeAddon()
    screen.loadAddon(serializer)
    const restored = new Terminal({
      cols: summary.cols,
      rows: summary.rows,
      allowProposedApi: true,
    })
    try {
      const lines = Array.from(
        { length: 100 },
        (_, index) => `\u001b[38;2;${index};3;7mLINE_${index}\r\n`,
      ).join("")
      await new Promise<void>((resolve) => screen.write(lines + "\u001b[31mVISIBLE", resolve))
      const full = snapshot(screen, serializer, summary, 9, 1024 * 1024)
      const budget = 1024
      expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(budget)
      const bounded = snapshot(screen, serializer, summary, 9, budget)
      expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(budget)
      expect(bounded.data).not.toContain("LINE_0")
      expect(bounded).toMatchObject({ terminalId: "terminal", sequence: 9, cols: 20, rows: 4 })
      await new Promise<void>((resolve) => restored.write(bounded.data, resolve))
      expect(text(restored)).toBe(text(screen))
      const visible = restored.buffer.active
        .getLine(restored.buffer.active.baseY + restored.rows - 1)!
        .getCell(0)!
      const original = screen.buffer.active
        .getLine(screen.buffer.active.baseY + screen.rows - 1)!
        .getCell(0)!
      expect(visible.getFgColor()).toBe(original.getFgColor())
    } finally {
      screen.dispose()
      restored.dispose()
    }
  })

  it("reports an oversized visible viewport instead of silently removing visible cells", async () => {
    const screen = new Terminal({ cols: summary.cols, rows: summary.rows, allowProposedApi: true })
    const serializer = new SerializeAddon()
    screen.loadAddon(serializer)
    try {
      await new Promise<void>((resolve) => screen.write("\u001b[31mVISIBLE", resolve))
      expect(() => snapshot(screen, serializer, summary, 1, 1)).toThrow(
        expect.objectContaining({ code: "SNAPSHOT_TOO_LARGE" }),
      )
      expect(text(screen)).toContain("VISIBLE")
    } finally {
      screen.dispose()
    }
  })

  it("preserves the active alternate screen when trimming normal scrollback", async () => {
    const screen = new Terminal({
      cols: summary.cols,
      rows: summary.rows,
      scrollback: 1000,
      allowProposedApi: true,
    })
    const serializer = new SerializeAddon()
    screen.loadAddon(serializer)
    const restored = new Terminal({
      cols: summary.cols,
      rows: summary.rows,
      allowProposedApi: true,
    })
    try {
      const lines = Array.from(
        { length: 100 },
        (_, index) => `\u001b[38;2;${index};3;7mLINE_${index}\r\n`,
      ).join("")
      await new Promise<void>((resolve) =>
        screen.write(lines + "\u001b[?1049h\u001b[32mALT_VIEWPORT", resolve),
      )
      const event = snapshot(screen, serializer, summary, 12, 1024)
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(1024)
      await new Promise<void>((resolve) => restored.write(event.data, resolve))
      expect(restored.buffer.active.type).toBe("alternate")
      expect(text(restored)).toBe(text(screen))
      expect(text(restored)).toContain("ALT_VIEWPORT")
    } finally {
      screen.dispose()
      restored.dispose()
    }
  })
})
