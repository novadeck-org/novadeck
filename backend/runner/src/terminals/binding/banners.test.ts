import { createScreen, type Screen } from "@novadeck/emulator/headless"
import { describe, expect, it } from "vitest"

import type { Record } from "../record.js"
import { bannerDrawn, bannerForgotten, bannerSeen } from "./banners.js"

// A terminal as the banner reader sees it: a real emulator screen, its pty and its binding.
const started = (rows = 40, cols = 120) => {
  const screen: Screen = createScreen({ cols, rows, scrollback: 0 })
  const record = { bound: null, terminal: { screen, pty: {} } }
  const draw = (text: string) =>
    new Promise<void>((resolve) => screen.write(text, resolve)).then(() =>
      bannerDrawn(record as unknown as Record),
    )
  return { record: record as unknown as Record, plain: record, screen, draw }
}

const banner = (version: string) => `  >_ OpenAI Codex (v${version})\r\n`
const alternate = "\x1b[?1049h\x1b[2J\x1b[H"
// A resumed conversation, replayed over the screen.
const replay = "\x1b[2J\x1b[H› Turn 1\r\n• Done 1.\r\n"

describe("a starting TUI's banner", () => {
  it("is seen in a draw that comes after blank ones, as the real start does", async () => {
    const { record, draw } = started()
    await draw(alternate)
    await draw("\r\n")
    expect(bannerSeen(record, "codex")).toBeUndefined()
    await draw(banner("0.166.0"))
    expect(bannerSeen(record, "codex")).toBe("0.166.0")
  })

  it("is kept when the very next draw covers it", async () => {
    const { record, draw } = started()
    await draw(alternate + banner("0.166.0"))
    await draw(replay)
    expect(bannerSeen(record, "codex")).toBe("0.166.0")
  })

  it("is seen on the normal buffer, where a terminal passes no switch to the alternate one", async () => {
    const { record, draw } = started()
    await draw(banner("0.166.0"))
    expect(bannerSeen(record, "codex")).toBe("0.166.0")
  })

  it("is the one nearest the bottom where an earlier process's stands above", async () => {
    const { record, draw } = started()
    await draw(`${banner("0.165.0")}\r\n› hi\r\n${banner("0.166.0")}`)
    expect(bannerSeen(record, "codex")).toBe("0.166.0")
  })

  it("is not taken for another agent, or from words in the conversation", async () => {
    const { record, draw } = started()
    await draw("› >_ OpenAI Codex (v9.9.9)\r\n")
    expect(bannerSeen(record, "codex")).toBeUndefined()
    await draw(banner("0.166.0"))
    expect(bannerSeen(record, "claude")).toBeUndefined()
  })

  it("is read from nothing once a session is bound", async () => {
    const { record, plain, draw } = started()
    plain.bound = {} as never
    await draw(banner("0.166.0"))
    plain.bound = null as never
    expect(bannerSeen(record, "codex")).toBeUndefined()
  })

  it("stays with the process for a session switch inside it, and goes with its end", async () => {
    const { record, draw } = started()
    await draw(alternate + banner("0.166.0"))
    await draw(replay)
    expect(bannerSeen(record, "codex")).toBe("0.166.0")
    expect(bannerSeen(record, "codex")).toBe("0.166.0")
    bannerForgotten(record)
    expect(bannerSeen(record, "codex")).toBeUndefined()
  })

  it("is not another pty's", async () => {
    const { record, plain, draw } = started()
    await draw(banner("0.166.0"))
    plain.terminal.pty = {}
    expect(bannerSeen(record, "codex")).toBeUndefined()
  })

  describe("left behind by an earlier process", () => {
    it("gives way to the upgraded one that starts after it left inline", async () => {
      const { record, draw } = started()
      await draw(banner("0.165.0"))
      expect(bannerSeen(record, "codex")).toBe("0.165.0")
      // It exits (the session ends), the banner still on the screen above the prompt.
      bannerForgotten(record)
      await draw("$ codex resume\r\n")
      expect(bannerSeen(record, "codex")).toBe("0.165.0")
      // The upgraded one starts, lower.
      await draw(banner("0.166.0"))
      expect(bannerSeen(record, "codex")).toBe("0.166.0")
    })

    it("gives way to the upgraded one that starts after one killed on the alternate screen", async () => {
      const { record, draw } = started()
      await draw(alternate + banner("0.165.0"))
      // Killed there: the shell's prompt draws on the same screen, then the new one starts
      // over it, and replays its conversation after its banner.
      await draw("$ codex resume\r\n")
      await draw(`\x1b[2J\x1b[H${banner("0.166.0")}`)
      await draw(replay)
      expect(bannerSeen(record, "codex")).toBe("0.166.0")
    })

    it("gives way to the upgraded one after a transcript replayed an old banner inline", async () => {
      const { record, draw } = started()
      await draw(`${banner("0.165.0")}› Turn 1\r\n• Done 1.\r\n`)
      expect(bannerSeen(record, "codex")).toBe("0.165.0")
      await draw(`$ codex resume\r\n${banner("0.166.0")}`)
      await draw(replay)
      expect(bannerSeen(record, "codex")).toBe("0.166.0")
    })
  })

  it("costs little to look for on a full screen", async () => {
    // Printed for a reader; asserted generously (2 ms a draw, some 30 times the cost on a
    // laptop), so a slow runner does not flake it.
    for (const [rows, cols] of [
      [40, 120],
      [80, 300],
    ] as const) {
      const { record, draw } = started(rows, cols)
      // eslint-disable-next-line no-await-in-loop -- Each size is measured on its own screen.
      await draw(alternate + "x".repeat(rows * cols))
      const began = performance.now()
      const runs = 1000
      for (let i = 0; i < runs; i++) bannerDrawn(record)
      const each = (performance.now() - began) / runs
      console.info(`banner scan, ${cols}x${rows} of text: ${(each * 1000).toFixed(1)} µs per draw`)
      expect(each).toBeLessThan(2)
    }
  })
})
