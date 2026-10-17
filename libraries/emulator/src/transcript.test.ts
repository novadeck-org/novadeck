import { describe, expect, it } from "vitest"

import { createScreen, type Screen } from "./screen.js"
import { replay, transcript } from "./transcript.js"

const screen = (cols = 40, rows = 5) => createScreen({ cols, rows, scrollback: 1000 })

const write = (terminal: Screen, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve))

const lines = (terminal: Screen): string[] => {
  const buffer = terminal.buffer.active
  return Array.from({ length: buffer.length }, (_, index) =>
    buffer.getLine(index)!.translateToString(true),
  )
}

describe("transcripts", () => {
  it("keep the newest lines within the limit, dropping older scrollback", async () => {
    const terminal = screen()
    await write(terminal, Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\r\n"))
    const whole = transcript(terminal, 1_000_000)!
    const capped = transcript(terminal, 400)!
    expect(whole).toContain("line 0\r\n")
    expect(capped.length).toBeLessThanOrEqual(400)
    expect(capped).toContain("line 199")
    expect(capped).not.toContain("line 0\r\n")
  })

  it("are nothing for a blank screen, or one too large to keep at all", async () => {
    const terminal = screen()
    expect(transcript(terminal, 1000)).toBeNull()
    await write(terminal, "x".repeat(150))
    expect(transcript(terminal, 10)).toBeNull()
  })

  it("leave out the alternate screen, so replaying one cannot enter it", async () => {
    const terminal = screen()
    await write(terminal, "prompt$ vim\r\n\x1b[?1049hFULL SCREEN")
    const text = transcript(terminal, 10_000)!
    expect(text).toContain("prompt$ vim")
    expect(text).not.toContain("FULL SCREEN")
    expect(text).not.toContain("\x1b[?1049h")
  })

  it("replay, then a separator on the line after the last one drawn", async () => {
    const old = screen()
    // A full-screen program left its cursor near the top.
    await write(old, "one\r\ntwo\r\nthree\x1b[1;1H")
    const fresh = screen()
    await replay(fresh, transcript(old, 10_000)!, "-- end --")
    await write(fresh, "$ ")
    const shown = lines(fresh).filter((line) => line)
    expect(shown.slice(0, 3)).toEqual(["one", "two", "three"])
    expect(shown[3]).toBe("-- end --")
    expect(shown[4]?.trim()).toBe("$")
  })

  it("replay alone when given no separator", async () => {
    const old = screen()
    await write(old, "one\r\ntwo")
    const fresh = screen()
    await replay(fresh, transcript(old, 10_000)!)
    expect(lines(fresh).filter((line) => line)).toEqual(["one", "two"])
  })
})
