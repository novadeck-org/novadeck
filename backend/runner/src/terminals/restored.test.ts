import { createScreen, replay, transcript } from "@novadeck/emulator/headless"

import { describe, expect, it } from "../test.js"
import { restoredSeparator, showRestored } from "./restored.js"

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

  it("stands alone where there is no earlier screen", async () => {
    const { terminal, calls } = played()
    await showRestored(terminal, "", null, "t1", "Claude Code wasn't resumed.")
    expect(calls).toEqual([["", "\x1b[0;2mClaude Code wasn't resumed.\x1b[0m"]])
  })
})
