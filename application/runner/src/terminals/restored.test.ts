import { createScreen, replay, transcript } from "@novadeck/emulator/headless"

import { describe, expect, it } from "../test.js"
import { restoredSeparator } from "./restored.js"

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
