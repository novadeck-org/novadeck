import type { HarnessEvent } from "@novadeck/harness-core/events"
import { afterEach, describe, expect, it, vi } from "vitest"

import { GivenBack } from "./given-back.js"

const started = (
  startedAt: number,
  more: { cause: "prompt"; prompt: string } | { cause: "doorbell"; nonce: string },
  firedAt?: number,
): HarnessEvent => ({
  type: "turn-started",
  agent: "claude",
  sessionId: "s",
  instance: "1",
  startedAt,
  ...(firedAt !== undefined && { firedAt }),
  ...more,
})

const prompt = (at: number, text: string, firedAt?: number) =>
  started(at, { cause: "prompt", prompt: text }, firedAt)

/** A Stop from 100 to 200, which gave back `words`. */
const stopped = (words: string | null) => {
  vi.useFakeTimers({ now: 100 })
  const given = new GivenBack()
  const end = given.begin("t", 100)
  vi.setSystemTime(200)
  end(words)
  return given
}

afterEach(() => vi.useRealTimers())

describe("given-back messages", () => {
  it("drops the turn a hook fires for a message the Stop gave back, as the Stop ends", async () => {
    const given = stopped("Queued beta\n[Novadeck: automatic notice, abc123]")
    expect(await given.late("t", [prompt(150, "Queued beta")])).toBe(true)
    expect(await given.late("t", [started(260, { cause: "doorbell", nonce: "abc123" })])).toBe(true)
  })

  it("tells of a message once", async () => {
    const given = stopped("Queued beta")
    expect(await given.late("t", [prompt(150, "Queued beta")])).toBe(true)
    expect(await given.late("t", [prompt(160, "Queued beta")])).toBe(false)
  })

  it("keeps the same words the person sends after the Stop ended", async () => {
    const given = stopped("fix the tests")
    expect(await given.late("t", [prompt(5_000, "fix the tests")])).toBe(false)
    // Started late, but fired before the Stop ended: still the message the Stop took.
    expect(await given.late("t", [prompt(5_000, "fix the tests", 150)])).toBe(true)
  })

  it("keeps a hook fired before the Stop, other words, a part of a line, or another terminal", async () => {
    const given = stopped("look into the build and push")
    expect(await given.late("t", [prompt(99, "look into the build and push")])).toBe(false)
    expect(await given.late("t", [prompt(150, "Carry on")])).toBe(false)
    expect(await given.late("t", [prompt(150, "push")])).toBe(false)
    expect(await given.late("u", [prompt(150, "look into the build and push")])).toBe(false)
  })

  it("matches a many-line message by its lines in a row", async () => {
    const given = stopped("one\ntwo\nthree")
    expect(await given.late("t", [prompt(150, "two\nthree")])).toBe(true)
    expect(await given.late("t", [prompt(150, "one\nthree")])).toBe(false)
  })

  it("keeps all where the Stop gave nothing back", async () => {
    const given = stopped(null)
    expect(await given.late("t", [prompt(150, "Queued beta")])).toBe(false)
  })

  it("waits for a Stop under way before it judges a hook fired after it began", async () => {
    vi.useFakeTimers({ now: 100 })
    const given = new GivenBack()
    const end = given.begin("t", 100)
    const judged = vi.fn<(late: boolean) => void>()
    void given.late("t", [prompt(150, "Queued beta")]).then(judged)
    await vi.advanceTimersByTimeAsync(50)
    expect(judged).not.toHaveBeenCalled()
    end("Queued beta")
    await vi.advanceTimersByTimeAsync(0)
    expect(judged).toHaveBeenCalledWith(true)
  })

  it("forgets what was given back after a minute, or with its terminal", async () => {
    const given = stopped("Queued beta")
    given.forget("t")
    expect(await given.late("t", [prompt(150, "Queued beta")])).toBe(false)
    const later = stopped("Queued beta")
    vi.setSystemTime(61_000)
    expect(await later.late("t", [prompt(60_900, "Queued beta", 150)])).toBe(false)
  })
})
