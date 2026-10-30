import { randomUUID } from "node:crypto"

import { command } from "@novadeck/terminal/testing"
import { vi } from "vitest"

import { Terminals } from "../terminals/manager.js"
import { describe, expect, it } from "../test.js"
import { fakeClock } from "./clock.js"
import { ptyOptions } from "./pty.js"
import { Resources } from "./resources.js"

describe("a fake clock", () => {
  it("runs the timers set on it, and those they set, before the real clock is back", async ({
    resources,
  }) => {
    const clock = fakeClock(resources, ["setTimeout", "clearTimeout"])
    const fired: string[] = []
    setTimeout(() => {
      fired.push("first")
      setTimeout(() => fired.push("second"), 60_000)
    }, 1_000)
    await clock.restore()
    expect(fired).toEqual(["first", "second"])
    expect(vi.isFakeTimers()).toBe(false)
  })

  it("is restored when the test's resources are disposed, before what was created first", async () => {
    const resources = new Resources()
    const seen: boolean[] = []
    resources.defer(() => {
      seen.push(vi.isFakeTimers())
    })
    fakeClock(resources, ["setTimeout", "clearTimeout"])
    await resources.dispose()
    expect(seen).toEqual([false])
  })

  // A close begun on the fake clock arms the kill that follows the hangup on it; restored
  // without running it, the close, and the shutdown awaiting it, would wait forever.
  it("lets a close begun on it end, for a program that ignores its hangup", async ({
    resources,
  }) => {
    const manager = new Terminals(ptyOptions)
    resources.defer(() => manager.shutdown())
    const terminal = await manager.create(
      {
        id: randomUUID(),
        sessionId: "session",
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      },
      "creator",
    )
    const controller = new AbortController()
    const stream = manager.attach(
      { terminalId: terminal.id, mode: "observe" },
      "observer",
      controller.signal,
    )
    resources.defer(async () => {
      controller.abort()
      await stream.return(undefined)
    })
    let output = ""
    let told = false
    for await (const event of stream) {
      if (event.type === "attached") continue
      if (event.type === "output" || event.type === "snapshot") output += event.data
      manager.ack({ terminalId: terminal.id, sequence: event.sequence }, "observer")
      if (output.includes("HANGUP_IGNORED")) break
      if (!told && output.includes("PTY_READY")) {
        told = true
        manager.write(
          { terminalId: terminal.id, data: command({ type: "ignoreHangup" }) },
          "creator",
        )
      }
    }
    const clock = fakeClock(resources, ["setTimeout", "clearTimeout", "Date"])
    const closing = manager.close({ terminalId: terminal.id })
    await vi.advanceTimersByTimeAsync(0)
    await clock.restore()
    await closing
  })
})
