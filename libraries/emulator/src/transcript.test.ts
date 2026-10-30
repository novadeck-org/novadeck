import { describe, expect, it } from "vitest"

import { createScreen, written, type Screen } from "./screen.js"
import { replay, transcript } from "./transcript.js"

const open = (cols = 40, rows = 5) => createScreen({ cols, rows, scrollback: 1000 })

const lines = (screen: Screen): string[] => {
  const buffer = screen.buffer.active
  return Array.from({ length: buffer.length }, (_, index) =>
    buffer.getLine(index)!.translateToString(true),
  )
}

describe("transcripts", () => {
  it("keep the newest lines within the limit, dropping older scrollback", async () => {
    const screen = open()
    await written(screen, Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\r\n"))
    const whole = transcript(screen, 1_000_000)!
    const capped = transcript(screen, 400)!
    expect(whole).toContain("line 0\r\n")
    expect(capped.length).toBeLessThanOrEqual(400)
    expect(capped).toContain("line 199")
    expect(capped).not.toContain("line 0\r\n")
  })

  it("are nothing for a blank screen, or one too large to keep at all", async () => {
    const screen = open()
    expect(transcript(screen, 1000)).toBeNull()
    await written(screen, "x".repeat(150))
    expect(transcript(screen, 10)).toBeNull()
  })

  it("leave out the alternate screen, so replaying one cannot enter it", async () => {
    const screen = open()
    await written(screen, "prompt$ vim\r\n\x1b[?1049hFULL SCREEN")
    const text = transcript(screen, 10_000)!
    expect(text).toContain("prompt$ vim")
    expect(text).not.toContain("FULL SCREEN")
    expect(text).not.toContain("\x1b[?1049h")
  })

  it("replay, then a separator on the line after the last one drawn", async () => {
    const old = open()
    // A full-screen program left its cursor near the top.
    await written(old, "one\r\ntwo\r\nthree\x1b[1;1H")
    const fresh = open()
    await replay(fresh, transcript(old, 10_000)!, "-- end --")
    await written(fresh, "$ ")
    const shown = lines(fresh).filter((line) => line)
    expect(shown.slice(0, 3)).toEqual(["one", "two", "three"])
    expect(shown[3]).toBe("-- end --")
    expect(shown[4]?.trim()).toBe("$")
  })

  it("replay into the scrollback when scrolled, leaving a blank screen from its top", async () => {
    const old = open()
    await written(old, "one\r\ntwo")
    const fresh = open()
    await replay(fresh, transcript(old, 10_000)!, "-- end --", true)
    // A Windows pseudoconsole draws at rows counted from the top of the screen.
    await written(fresh, "C:\\>\x1b[1;5Hx")
    expect(fresh.buffer.active.baseY).toBe(3)
    expect(lines(fresh)).toEqual(["one", "two", "-- end --", "C:\\>x", "", "", "", ""])
  })

  it("replay alone when given no separator", async () => {
    const old = open()
    await written(old, "one\r\ntwo")
    const fresh = open()
    await replay(fresh, transcript(old, 10_000)!)
    expect(lines(fresh).filter((line) => line)).toEqual(["one", "two"])
  })
})
