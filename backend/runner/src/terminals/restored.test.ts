import { createScreen, replay, transcript } from "@novadeck/emulator/headless"

import { describe, expect, it } from "../test.js"
import { noteAbove, restoredSeparator, showRestored } from "./restored.js"

describe("the separator after a restored transcript", () => {
  it("is dim, and names the day the transcript was saved when it is known", () => {
    expect(restoredSeparator(null)).toBe("\x1b[0;2m── restored transcript ──\x1b[0m")
    const savedAt = new Date(2026, 0, 2, 3, 4)
    expect(restoredSeparator(savedAt)).toContain(` · saved ${savedAt.toLocaleString()} ──`)
  })

  it("replays on the line after the last one drawn", async () => {
    const old = createScreen({ cols: 40, rows: 5, scrollback: 1000 })
    await new Promise<void>((resolve) => old.write("one\r\ntwo\x1b[1;1H", resolve))
    const fresh = createScreen({ cols: 40, rows: 5, scrollback: 1000 })
    await replay(fresh, transcript(old, 10_000)!, restoredSeparator(null))
    const buffer = fresh.buffer.active
    const shown = Array.from({ length: buffer.length }, (_, row) =>
      buffer.getLine(row)!.translateToString(true),
    ).filter((line) => line)
    expect(shown).toEqual(["one", "two", "── restored transcript ──"])
  })
})

describe("showing a terminal's earlier screen", () => {
  it("lets a replay that fails go, so the save after it runs and nothing is left unhandled", async () => {
    const ended = { replay: () => Promise.reject(new Error("the terminal is gone")) }
    await expect(showRestored(ended, "earlier", null, "t1")).resolves.toBeUndefined()
  })
})

describe("saying why an agent was not resumed", () => {
  const played = () => {
    const calls: [string, string | undefined][] = []
    const terminal = {
      replay: (text: string, separator?: string) => {
        calls.push([text, separator])
        return Promise.resolve()
      },
    }
    return { terminal, calls }
  }

  it("follows the earlier screen's separator, dim, on the line under it", async () => {
    const { terminal, calls } = played()
    await showRestored(terminal, "earlier", null, "t1", "Claude Code wasn't resumed.")
    expect(calls).toEqual([
      ["earlier", `${restoredSeparator(null)}\r\n\x1b[0;2mClaude Code wasn't resumed.\x1b[0m`],
    ])
  })

  it("is the first line, under no blank one, where there is no earlier screen", async () => {
    const { terminal, calls } = played()
    await showRestored(terminal, "", null, "t1", "Claude Code wasn't resumed.")
    expect(calls).toEqual([["\x1b[0;2mClaude Code wasn't resumed.\x1b[0m\r\n", undefined]])
  })
})

describe("telling the person above the prompt", () => {
  const rows = (screen: ReturnType<typeof createScreen>) => {
    const buffer = screen.buffer.active
    return Array.from({ length: buffer.length }, (_, row) =>
      buffer.getLine(row)!.translateToString(true),
    ).filter((line) => line)
  }
  const drawn = async (screen: ReturnType<typeof createScreen>, text: string) =>
    new Promise<void>((resolve) => screen.write(text, resolve))

  it("leaves the prompt as it was, under the note, with the cursor after it", async () => {
    const screen = createScreen({ cols: 40, rows: 6, scrollback: 100 })
    await drawn(screen, "one\r\n$ ")
    await drawn(screen, noteAbove("Claude Code wasn't resumed.", screen))
    expect(rows(screen)).toEqual(["one", "Claude Code wasn't resumed.", "$ "])
    expect([screen.buffer.active.cursorY, screen.buffer.active.cursorX]).toEqual([2, 2])
  })

  it("scrolls once where the prompt is on the screen's last row, losing nothing", async () => {
    const screen = createScreen({ cols: 40, rows: 3, scrollback: 100 })
    await drawn(screen, "one\r\ntwo\r\n$ ")
    await drawn(screen, noteAbove("Not resumed.", screen))
    expect(rows(screen)).toEqual(["one", "two", "Not resumed.", "$ "])
    expect([screen.buffer.active.cursorY, screen.buffer.active.cursorX]).toEqual([2, 2])
  })

  it("makes room for a note that wraps", async () => {
    const screen = createScreen({ cols: 10, rows: 6, scrollback: 100 })
    await drawn(screen, "$ ")
    await drawn(screen, noteAbove("a".repeat(15), screen))
    expect(rows(screen)).toEqual(["aaaaaaaaaa", "aaaaa", "$ "])
  })
})
