import type { HarnessEvent } from "@novadeck/harness-core/events"
import { describe, expect, it, vi } from "vitest"

import { GivenBack } from "./given-back.js"

const started = (
  startedAt: number,
  more: { cause: "prompt"; prompt: string } | { cause: "doorbell"; nonce: string },
): HarnessEvent => ({
  type: "turn-started",
  agent: "claude",
  sessionId: "s",
  instance: "1",
  startedAt,
  ...more,
})

describe("given-back messages", () => {
  it("drops the turn a hook starts for a message the Stop gave back, after the Stop began", async () => {
    const given = new GivenBack()
    given.begin("t", 100)("Queued beta\n[Novadeck: automatic notice, abc123]")
    expect(await given.late("t", [started(150, { cause: "prompt", prompt: "Queued beta" })])).toBe(
      true,
    )
    expect(await given.late("t", [started(160, { cause: "doorbell", nonce: "abc123" })])).toBe(true)
  })

  it("keeps a hook that started before the Stop, or told of other words", async () => {
    const given = new GivenBack()
    given.begin("t", 100)("Queued beta")
    expect(await given.late("t", [started(99, { cause: "prompt", prompt: "Queued beta" })])).toBe(
      false,
    )
    expect(await given.late("t", [started(150, { cause: "prompt", prompt: "Carry on" })])).toBe(
      false,
    )
    expect(await given.late("u", [started(150, { cause: "prompt", prompt: "Queued beta" })])).toBe(
      false,
    )
  })

  it("keeps all where the Stop gave nothing back", async () => {
    const given = new GivenBack()
    given.begin("t", 100)(null)
    expect(await given.late("t", [started(150, { cause: "prompt", prompt: "Queued beta" })])).toBe(
      false,
    )
  })

  it("waits for a Stop under way before it judges a hook that started after it", async () => {
    const given = new GivenBack()
    const end = given.begin("t", 100)
    const judged = vi.fn<(late: boolean) => void>()
    const late = given.late("t", [started(150, { cause: "prompt", prompt: "Queued beta" })])
    void late.then(judged)
    await Promise.resolve()
    expect(judged).not.toHaveBeenCalled()
    end("Queued beta")
    expect(await late).toBe(true)
  })

  it("forgets what was given back after a minute", async () => {
    vi.useFakeTimers()
    try {
      const given = new GivenBack()
      given.begin("t", 100)("Queued beta")
      vi.advanceTimersByTime(61_000)
      expect(
        await given.late("t", [started(150, { cause: "prompt", prompt: "Queued beta" })]),
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
