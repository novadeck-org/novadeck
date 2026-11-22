import type { ScreenText } from "@novadeck/emulator/headless"
import { describe, expect, it } from "vitest"

import type { BoxProfile } from "./box/box.js"
import { Interrupts, type InterruptHost } from "./interrupts.js"
import { screen as screenOf } from "./testing/screens.js"

// A program whose first Escape only arms the interrupt (opencode: `esc again to interrupt`).
const terminal = (arms: boolean, works = true) => {
  const written: string[] = []
  let armed = false
  let working = works
  const profile: BoxProfile = {
    read: () => undefined,
    stands: () => false,
    textWidth: (columns) => columns,
    collapsed: () => false,
    shell: { expands: false, starts: false, footer: () => false },
    queued: () => false,
    overlay: () => false,
    collapses: () => false,
    room: (rows) => rows,
    armed: (screen) => screen.rows.includes("esc again to interrupt"),
  }
  const host: InterruptHost = {
    admit: () => undefined,
    working: () => working,
    alive: () => true,
    profile: () => profile,
    prompt: () => "do it",
    screen: async (): Promise<ScreenText> =>
      screenOf({ rows: [armed ? "esc again to interrupt" : "esc interrupt"] }),
    type: (_id, data) => {
      written.push(data)
      if (data === "\x1b" && !armed && arms) armed = true
      else if (data === "\x1b") working = false
      return true
    },
    write: () => true,
  } as InterruptHost
  return { host, written }
}

describe("an interrupt of a program whose first Escape arms it", () => {
  it("writes a second Escape once the screen says it is armed", async () => {
    const { host, written } = terminal(true)
    await new Interrupts(host, { settleMs: 0, armedMs: 500 }).interrupt("t")
    expect(written).toEqual(["\x1b", "\x1b"])
  })

  it("writes no second where the screen never says so, and none to a turn that ended", async () => {
    const never = terminal(false)
    await new Interrupts(never.host, { settleMs: 0, armedMs: 100 }).interrupt("t")
    expect(never.written).toEqual(["\x1b"])
    const idle = terminal(true, false)
    await new Interrupts(idle.host, { settleMs: 0, armedMs: 100 }).interrupt("t")
    expect(idle.written).toEqual([])
  })
})
