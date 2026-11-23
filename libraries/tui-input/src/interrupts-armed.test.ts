import type { ScreenText } from "@novadeck/emulator/headless"
import { describe, expect, it } from "vitest"

import type { BoxProfile } from "./box/box.js"
import { Interrupts, type InterruptHost } from "./interrupts.js"
import { screen as screenOf } from "./testing/screens.js"

// A program whose first Escape only arms the interrupt (opencode: `esc again to interrupt`). `row`
// is what its status row says as each Escape comes: after the first, `armed` or what `then` says.
const terminal = (then: "arms" | "nothing" | "ends") => {
  const written: string[] = []
  const typed: string[] = []
  let row = "esc interrupt"
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
    working: (screen) => screen.rows.some((each) => /esc (?:again to )?interrupt/.test(each)),
  }
  const host: InterruptHost = {
    admit: () => undefined,
    working: () => true,
    alive: () => true,
    profile: () => profile,
    prompt: () => "do it",
    screen: async (): Promise<ScreenText> => screenOf({ rows: [row] }),
    // The runner counts a stop for what is typed, never for what is only written.
    type: (_id, data) => {
      typed.push(data)
      row = ""
      return true
    },
    write: (_id, data) => {
      written.push(data)
      row = then === "arms" ? "esc again to interrupt" : then === "ends" ? "" : "esc interrupt"
      return true
    },
  } as InterruptHost
  return { host, written, typed }
}

describe("an interrupt of a program whose first Escape arms it", () => {
  it("writes the first Escape alone and types the second, which is the stop, once armed", async () => {
    const { host, written, typed } = terminal("arms")
    await new Interrupts(host, { settleMs: 0, armedMs: 500 }).interrupt("t")
    expect(written).toEqual(["\x1b"])
    expect(typed).toEqual(["\x1b"])
  })

  it("counts no stop where nothing armed, and does not hold for it once the turn's row is gone", async () => {
    const closed = terminal("ends")
    const began = Date.now()
    await new Interrupts(closed.host, { settleMs: 0, armedMs: 5_000 }).interrupt("t")
    expect(closed.written).toEqual(["\x1b"])
    expect(closed.typed).toEqual([])
    expect(Date.now() - began).toBeLessThan(1_000)
  })

  it("waits no longer than armedMs where the turn's row stays and nothing arms", async () => {
    const stuck = terminal("nothing")
    await new Interrupts(stuck.host, { settleMs: 0, armedMs: 150 }).interrupt("t")
    expect(stuck.written).toEqual(["\x1b"])
    expect(stuck.typed).toEqual([])
  })
})
