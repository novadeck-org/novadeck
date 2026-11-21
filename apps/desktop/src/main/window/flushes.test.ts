import { vi } from "vitest"

import { describe, expect, it } from "../../test"
import { createFlushes, flushWaitMs } from "./flushes"

const setup = (hears = true) => {
  const sent: string[] = []
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = []
  let counter = 0
  const flushes = createFlushes<string>({
    send: (window, id) => {
      sent.push(`${window}:${id}`)
      return hears
    },
    later: (run, ms) => {
      const timer = { run, ms, cancelled: false }
      timers.push(timer)
      return () => void (timer.cancelled = true)
    },
    nextId: () => `ask-${++counter}`,
  })
  return { flushes, sent, timers }
}

describe("asking a page to flush its saves", () => {
  it("resolves once the page answers, and gives up the wait", async () => {
    const { flushes, sent, timers } = setup()
    const done = vi.fn<() => void>()
    void flushes.ask("a").then(done)
    expect(sent).toEqual(["a:ask-1"])
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    flushes.answered("ask-1")
    await Promise.resolve()
    expect(done).toHaveBeenCalledOnce()
    expect(timers[0]!.cancelled).toBe(true)
  })

  it("stops waiting after a while, so a window that hangs holds no swap up", async () => {
    const { flushes, timers } = setup()
    const done = vi.fn<() => void>()
    void flushes.ask("a").then(done)
    expect(timers[0]!.ms).toBe(flushWaitMs)
    timers[0]!.run()
    await Promise.resolve()
    expect(done).toHaveBeenCalledOnce()
  })

  it("does not wait for a window that can't hear", async () => {
    const { flushes, timers } = setup(false)
    await flushes.ask("a")
    expect(timers).toHaveLength(0)
  })

  it("ignores an answer to nothing, or a second answer", async () => {
    const { flushes } = setup()
    flushes.answered("nobody")
    void flushes.ask("a")
    flushes.answered("ask-1")
    expect(() => flushes.answered("ask-1")).not.toThrow()
  })
})
