import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../../test"
import { createDemoVoice, demoTranscript } from "./voice"

describe("the demo's voice input", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("installs through the engine, the model and a check, then turns on", async () => {
    const voice = createDemoVoice({ step: 100, transcribe: 10 })
    expect(voice.state.getSnapshot()).toMatchObject({ installed: [], enabled: false })
    voice.install("turbo")
    await vi.advanceTimersByTimeAsync(50)
    expect(voice.state.getSnapshot().installing).toMatchObject({ model: "turbo", step: "engine" })
    await vi.advanceTimersByTimeAsync(100)
    expect(voice.state.getSnapshot().installing?.step).toBe("model")
    await vi.advanceTimersByTimeAsync(100)
    expect(voice.state.getSnapshot().installing?.step).toBe("check")
    await vi.advanceTimersByTimeAsync(100)
    expect(voice.state.getSnapshot()).toMatchObject({
      installing: null,
      installed: ["turbo"],
      enabled: true,
      check: { model: "turbo", gpu: true },
    })
  })

  it("leaves voice input off for another model when the person turned it off", async () => {
    const voice = createDemoVoice({ step: 100, transcribe: 10 })
    voice.install("turbo")
    await vi.advanceTimersByTimeAsync(400)
    voice.set({ enabled: false })

    voice.install("small")
    await vi.advanceTimersByTimeAsync(300)

    expect(voice.state.getSnapshot()).toMatchObject({ model: "small", enabled: false })
  })

  it("stops an install on cancel, and forgets everything on uninstall", async () => {
    const voice = createDemoVoice({ step: 100, transcribe: 10 })
    voice.install("small")
    await vi.advanceTimersByTimeAsync(150)
    voice.cancel()
    await vi.advanceTimersByTimeAsync(1000)
    expect(voice.state.getSnapshot()).toMatchObject({ installing: null, installed: [] })
    voice.install("small")
    await vi.advanceTimersByTimeAsync(400)
    voice.uninstall()
    expect(voice.state.getSnapshot()).toMatchObject({ installed: [], enabled: false })
  })

  it("refuses a model that is not installed", () => {
    const voice = createDemoVoice()
    voice.set({ enabled: true })
    expect(voice.state.getSnapshot()).toMatchObject({
      enabled: false,
      failure: "That model isn't installed.",
    })
  })

  it("answers a canned transcript shortly after a clip ends", async () => {
    const voice = createDemoVoice({ step: 100, transcribe: 10 })
    const clip = voice.record()
    clip.append(Int16Array.of(1))
    const done = clip.finish()
    await vi.advanceTimersByTimeAsync(10)
    await expect(done).resolves.toEqual({ text: demoTranscript, language: "en" })
  })
})
