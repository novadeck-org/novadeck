import { SerializeAddon } from "@xterm/addon-serialize"
import headless from "@xterm/headless"

import { describe, expect, it } from "../test.js"
import { replay, transcriptOf } from "./transcript.js"

const { Terminal } = headless

const screen = (cols = 40, rows = 5) => {
  const terminal = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
  const serializer = new SerializeAddon()
  terminal.loadAddon(serializer)
  return { terminal, serializer }
}

const write = (terminal: InstanceType<typeof Terminal>, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve))

const lines = (terminal: InstanceType<typeof Terminal>): string[] => {
  const buffer = terminal.buffer.active
  return Array.from({ length: buffer.length }, (_, index) =>
    buffer.getLine(index)!.translateToString(true),
  )
}

describe("transcripts", () => {
  it("keep the newest lines within the limit, dropping older scrollback", async () => {
    const { terminal, serializer } = screen()
    await write(terminal, Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\r\n"))
    const whole = transcriptOf(terminal, serializer, 1_000_000)!
    const capped = transcriptOf(terminal, serializer, 400)!
    expect(whole).toContain("line 0\r\n")
    expect(capped.length).toBeLessThanOrEqual(400)
    expect(capped).toContain("line 199")
    expect(capped).not.toContain("line 0\r\n")
  })

  it("are nothing for a blank screen, or one too large to keep at all", async () => {
    const { terminal, serializer } = screen()
    expect(transcriptOf(terminal, serializer, 1000)).toBeNull()
    await write(terminal, "x".repeat(150))
    expect(transcriptOf(terminal, serializer, 10)).toBeNull()
  })

  it("leave out the alternate screen, so replaying one cannot enter it", async () => {
    const { terminal, serializer } = screen()
    await write(terminal, "prompt$ vim\r\n\x1b[?1049hFULL SCREEN")
    const text = transcriptOf(terminal, serializer, 10_000)!
    expect(text).toContain("prompt$ vim")
    expect(text).not.toContain("FULL SCREEN")
    expect(text).not.toContain("\x1b[?1049h")
  })

  it("replay above a separator on the line after the last one drawn", async () => {
    const old = screen()
    // A full-screen program left its cursor near the top.
    await write(old.terminal, "one\r\ntwo\r\nthree\x1b[1;1H")
    const fresh = screen()
    await replay(fresh.terminal, transcriptOf(old.terminal, old.serializer, 10_000)!, null)
    await write(fresh.terminal, "$ ")
    const shown = lines(fresh.terminal).filter((line) => line)
    expect(shown.slice(0, 3)).toEqual(["one", "two", "three"])
    expect(shown[3]).toMatch(/── restored transcript ──/)
    expect(shown[4]?.trim()).toBe("$")
  })
})
