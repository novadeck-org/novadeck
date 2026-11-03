import { createScreen, type Screen } from "@novadeck/emulator/headless"
import { describe, expect, it } from "vitest"

import type { Record } from "../record.js"
import { bannerDrawn, bannerForgotten, bannerTaken } from "./banners.js"

// A terminal as the banner reader sees it: a real emulator screen, its pty and its binding.
const started = (rows = 40, cols = 120) => {
  const screen: Screen = createScreen({ cols, rows, scrollback: 0 })
  const record = { bound: null, promptedAt: 1, terminal: { screen, pty: {} } }
  const draw = (text: string) =>
    new Promise<void>((resolve) => screen.write(text, resolve)).then(() =>
      bannerDrawn(record as unknown as Record),
    )
  return { record: record as unknown as Record, plain: record, draw }
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
    expect(bannerTaken(record, "codex")).toBeUndefined()
    await draw(banner("0.166.0"))
    expect(bannerTaken(record, "codex")).toBe("0.166.0")
  })

  it("is kept when the very next draw covers it", async () => {
    const { record, draw } = started()
    await draw(alternate + banner("0.166.0"))
    await draw(replay)
    expect(bannerTaken(record, "codex")).toBe("0.166.0")
  })

  it("is seen on the normal buffer, where a terminal passes no switch to the alternate one", async () => {
    const { record, draw } = started()
    await draw(banner("0.166.0"))
    expect(bannerTaken(record, "codex")).toBe("0.166.0")
  })

  it("is the one nearest the bottom where an earlier process's stands above", async () => {
    const { record, draw } = started()
    await draw(`${banner("0.165.0")}\r\n› hi\r\n${banner("0.166.0")}`)
    expect(bannerTaken(record, "codex")).toBe("0.166.0")
  })

  it("is not taken for another agent, or from words in the conversation", async () => {
    const { record, draw } = started()
    await draw("› >_ OpenAI Codex (v9.9.9)\r\n")
    expect(bannerTaken(record, "codex")).toBeUndefined()
    await draw(banner("0.166.0"))
    expect(bannerTaken(record, "claude")).toBeUndefined()
  })

  it("is read from nothing once a session is bound", async () => {
    const { record, plain, draw } = started()
    plain.bound = {} as never
    await draw(banner("0.166.0"))
    plain.bound = null as never
    expect(bannerTaken(record, "codex")).toBeUndefined()
  })

  it("is taken by the binding once, and not by a later process of the terminal", async () => {
    const { record, draw } = started()
    await draw(alternate + banner("0.165.0"))
    expect(bannerTaken(record, "codex")).toBe("0.165.0")
    // The agent was killed on the alternate screen and an upgraded one resumes there, its
    // banner covered before it binds: the old one is not its own.
    await draw(replay)
    expect(bannerTaken(record, "codex")).toBeUndefined()
  })

  it("is the old one's no more once the shell has prompted, though it was never taken", async () => {
    const { record, plain, draw } = started()
    await draw(alternate + banner("0.165.0"))
    // Killed without binding; the shell prompts, and an upgraded resume covers its banner.
    plain.promptedAt = 2
    await draw(replay)
    expect(bannerTaken(record, "codex")).toBeUndefined()
    plain.promptedAt = 3
    await draw(banner("0.166.0"))
    expect(bannerTaken(record, "codex")).toBe("0.166.0")
  })

  it("is forgotten when its agent ends", async () => {
    const { record, draw } = started()
    await draw(banner("0.166.0"))
    bannerForgotten(record)
    expect(bannerTaken(record, "codex")).toBeUndefined()
  })

  it("costs little to look for on a full screen", async () => {
    const { record, draw } = started(40, 120)
    await draw(alternate + "x".repeat(120 * 40))
    const began = performance.now()
    const runs = 2000
    for (let i = 0; i < runs; i++) bannerDrawn(record)
    const each = (performance.now() - began) / runs
    console.info(`banner scan, 40x120 screen: ${(each * 1000).toFixed(1)} µs per draw`)
    expect(each).toBeLessThan(0.5)
  })
})
