import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../../test"
import { createDemoVoice, demoTranscript, heldVoiceTiming } from "./voice"

describe("the demo's voice input", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const uninstalled = (step = 100) => createDemoVoice({ step, transcribe: 10 }, "uninstalled")

  it("starts installed and on, as the try demo shows it", () => {
    const voice = createDemoVoice()
    expect(voice.state.getSnapshot()).toMatchObject({
      installed: ["turbo"],
      enabled: true,
      wanted: true,
      check: { model: "turbo" },
    })
  })

  it("installs through the engine, the model and a check, then turns on", async () => {
    const voice = uninstalled()
    expect(voice.state.getSnapshot()).toMatchObject({ installed: [], enabled: false })
    voice.install()
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
      check: { model: "turbo" },
    })
  })

  it("stops an install on cancel, and forgets everything on uninstall", async () => {
    const voice = uninstalled()
    voice.install()
    await vi.advanceTimersByTimeAsync(150)
    voice.cancel()
    await vi.advanceTimersByTimeAsync(1000)
    expect(voice.state.getSnapshot()).toMatchObject({ installing: null, installed: [] })
    voice.install()
    await vi.advanceTimersByTimeAsync(400)
    voice.uninstall()
    expect(voice.state.getSnapshot()).toMatchObject({
      installed: [],
      enabled: false,
      wanted: false,
    })
  })

  it("holds a held install at its engine however long it waits, until a cancel leaves nothing", async () => {
    const voice = createDemoVoice(heldVoiceTiming, "uninstalled")
    voice.install()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(voice.state.getSnapshot().installing).toMatchObject({ step: "engine" })
    voice.cancel()
    // Nothing of it resumes, however long after.
    await vi.advanceTimersByTimeAsync(10 * 400_000_000)
    expect(voice.state.getSnapshot()).toMatchObject({ installing: null, installed: [] })
  })

  it("keeps an off chosen during a first install, as the runner", async () => {
    const voice = uninstalled(10)
    voice.install()
    voice.set({ enabled: false })
    await vi.advanceTimersByTimeAsync(100)
    expect(voice.state.getSnapshot()).toMatchObject({
      installed: ["turbo"],
      enabled: false,
      wanted: false,
    })
  })

  it("is wanted until turned off, and turned on before an install is wanted again", () => {
    const voice = uninstalled()
    expect(voice.state.getSnapshot()).toMatchObject({ enabled: false, wanted: true })
    voice.set({ enabled: false })
    expect(voice.state.getSnapshot()).toMatchObject({ enabled: false, wanted: false })
    voice.set({ enabled: true })
    expect(voice.state.getSnapshot()).toMatchObject({ enabled: false, wanted: true })
  })

  it("shows each state of the offer on demand", async () => {
    const voice = createDemoVoice({ step: 100, transcribe: 10 })
    voice.show("declined")
    expect(voice.state.getSnapshot()).toMatchObject({ installed: [], wanted: false })
    // Each arms the next install, which the offer's Turn on starts.
    voice.show("network-failure")
    voice.install()
    await vi.advanceTimersByTimeAsync(300)
    expect(voice.state.getSnapshot()).toMatchObject({
      installed: [],
      wanted: true,
      installing: null,
      failure: expect.stringContaining("connection dropped"),
    })
    voice.show("installing")
    voice.install()
    await vi.advanceTimersByTimeAsync(1000)
    expect(voice.state.getSnapshot().installing).toMatchObject({ step: "model" })
    voice.show("install-and-finish")
    voice.install()
    await vi.advanceTimersByTimeAsync(400)
    expect(voice.state.getSnapshot()).toMatchObject({ installed: ["turbo"], enabled: true })
    voice.show("uninstalled")
    expect(voice.state.getSnapshot()).toMatchObject({ installed: [], wanted: true })
  })

  it("keeps the last check until a new one passes, and what an install got to when it stops", async () => {
    const voice = createDemoVoice({ step: 100, transcribe: 10 })
    const check = voice.state.getSnapshot().check
    voice.install()
    await vi.advanceTimersByTimeAsync(50)
    expect(voice.state.getSnapshot().check).toEqual(check)
    voice.cancel()

    const fresh = createDemoVoice({ step: 100, transcribe: 10 }, "uninstalled")
    fresh.install()
    // Past the engine and the model: into the check.
    await vi.advanceTimersByTimeAsync(250)
    fresh.cancel()
    expect(fresh.state.getSnapshot()).toMatchObject({
      installing: null,
      engineInstalled: true,
      installed: ["turbo"],
      check: null,
    })
  })

  it("leaves the engine on disk when an install fails after its step", async () => {
    const voice = createDemoVoice({ step: 100, transcribe: 10 })
    voice.show("network-failure")
    voice.install()
    await vi.advanceTimersByTimeAsync(300)
    expect(voice.state.getSnapshot()).toMatchObject({
      engineInstalled: true,
      installed: [],
      installing: null,
    })
    expect(voice.state.getSnapshot().failure).not.toBeNull()
  })

  it("reaches the not-set-up state, which a retry only checks", async () => {
    const voice = createDemoVoice({ step: 100, transcribe: 10 })
    voice.show("cancelled-at-check")
    expect(voice.state.getSnapshot()).toMatchObject({
      engineInstalled: true,
      installed: ["turbo"],
      check: null,
    })
    voice.install()
    await vi.advanceTimersByTimeAsync(150)
    expect(voice.state.getSnapshot()).toMatchObject({ installed: ["turbo"], enabled: true })
  })

  it("keeps the aim at small through an uninstall under software rendering", () => {
    const voice = createDemoVoice({ step: 100, transcribe: 10 })
    voice.show("software-graphics")
    voice.uninstall()
    expect(voice.state.getSnapshot().aim).toBe("small")
    voice.show("uninstalled")
    voice.uninstall()
    expect(voice.state.getSnapshot().aim).toBe("turbo")
  })

  it("only wants a model that never passed its check when it is turned on", () => {
    const voice = createDemoVoice({ step: 100, transcribe: 10 })
    voice.show("cancelled-at-check")
    voice.set({ enabled: true })
    expect(voice.state.getSnapshot()).toMatchObject({ enabled: false, wanted: true })
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
