import { vi } from "vitest"

import { askFixer } from "./fixer-call"
import { describe, expect, it } from "./test"

const refusal = (code: string) => Object.assign(new Error(code), { code })
const call = () => vi.fn<(terminalId: string) => Promise<void>>()
const refused = () => vi.fn<() => void>()
const options = (onRefused = refused()) => ({ tries: 5, retryMs: 2000, onRefused })

describe("Asking for the tour's second fixer", () => {
  it("asks once where the backend takes the shell", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const fixer = call().mockResolvedValue(undefined)
    const onRefused = refused()
    askFixer(fixer, "a", options(onRefused))
    await Promise.resolve()
    expect(fixer).toHaveBeenCalledTimes(1)
    expect(onRefused).not.toHaveBeenCalled()
  })

  it("refuses the shell for good on a conflict, to ask for the next", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.useFakeTimers()
    const fixer = call().mockRejectedValue(refusal("CONFLICT"))
    const onRefused = refused()
    askFixer(fixer, "a", options(onRefused))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onRefused).toHaveBeenCalledTimes(1)
    expect(fixer).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it("asks again after another refusal, as one meant to pass, and doesn't refuse the shell", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.useFakeTimers()
    const fixer = call()
      .mockRejectedValueOnce(refusal("CONTROL_IN_USE"))
      .mockRejectedValueOnce(refusal("CONTROL_IN_USE"))
      .mockResolvedValue(undefined)
    const onRefused = refused()
    askFixer(fixer, "a", options(onRefused))
    await vi.advanceTimersByTimeAsync(4_100)
    expect(fixer).toHaveBeenCalledTimes(3)
    expect(onRefused).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("refuses the shell once its tries are spent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.useFakeTimers()
    const fixer = call().mockRejectedValue(refusal("CONTROL_IN_USE"))
    const onRefused = refused()
    askFixer(fixer, "a", options(onRefused))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fixer).toHaveBeenCalledTimes(6)
    expect(onRefused).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it("sets no timer for a call answered after it was stopped", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.useFakeTimers()
    let fail: (error: unknown) => void = () => {}
    const fixer = call().mockReturnValue(new Promise((_, reject) => (fail = reject)))
    const stop = askFixer(fixer, "a", options())
    stop()
    fail(refusal("CONTROL_IN_USE"))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fixer).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
