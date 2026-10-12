import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { createDemoMurmur } from "./murmur"

describe("the demo's murmur", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("installs through the engine, the model and a check, then turns on", async () => {
    const murmur = createDemoMurmur({
      step: 100,
      device: "Intel Arc Graphics",
    })
    expect(murmur.state.getSnapshot()).toMatchObject({
      installed: false,
      enabled: false,
    })
    murmur.install()
    await vi.advanceTimersByTimeAsync(50)
    expect(murmur.state.getSnapshot().installing).toMatchObject({
      step: "engine",
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(murmur.state.getSnapshot().installing?.step).toBe("model")
    await vi.advanceTimersByTimeAsync(100)
    expect(murmur.state.getSnapshot().installing?.step).toBe("check")
    await vi.advanceTimersByTimeAsync(100)
    expect(murmur.state.getSnapshot()).toMatchObject({
      installing: null,
      installed: true,
      enabled: true,
      check: { device: "Intel Arc Graphics" },
      failure: null,
    })
  })

  context("on a computer with no working GPU", () => {
    it("installs the files, leaves murmur off and says it needs a GPU", async () => {
      const murmur = createDemoMurmur({ step: 100, device: null })
      murmur.install()
      await vi.advanceTimersByTimeAsync(400)
      expect(murmur.state.getSnapshot()).toMatchObject({
        installing: null,
        installed: true,
        enabled: false,
        check: null,
        failure: expect.stringMatching(/needs a GPU/),
      })
    })

    it("only runs the check again on another try", async () => {
      const murmur = createDemoMurmur({ step: 100, device: null })
      murmur.install()
      await vi.advanceTimersByTimeAsync(400)
      murmur.install()
      await vi.advanceTimersByTimeAsync(50)
      expect(murmur.state.getSnapshot()).toMatchObject({
        installing: { step: "check" },
        failure: null,
      })
    })
  })

  it("stops an install on cancel", async () => {
    const murmur = createDemoMurmur({ step: 100, device: "GPU" })
    murmur.install()
    await vi.advanceTimersByTimeAsync(150)
    murmur.cancel()
    await vi.advanceTimersByTimeAsync(500)
    expect(murmur.state.getSnapshot()).toMatchObject({
      installing: null,
      installed: false,
    })
  })

  it("stays off after the person turns it off, and when it is uninstalled", async () => {
    const murmur = createDemoMurmur({ step: 100, device: "GPU" })
    murmur.install()
    await vi.advanceTimersByTimeAsync(400)
    murmur.set({ enabled: false })
    expect(murmur.state.getSnapshot()).toMatchObject({
      enabled: false,
      wanted: false,
    })
    murmur.uninstall()
    expect(murmur.state.getSnapshot()).toMatchObject({
      installed: false,
      enabled: false,
      wanted: false,
      check: null,
    })
  })

  it("wants murmur before an install when it is turned on there", () => {
    const murmur = createDemoMurmur({ step: 100, device: "GPU" })
    murmur.set({ enabled: true })
    expect(murmur.state.getSnapshot()).toMatchObject({
      installed: false,
      enabled: false,
      wanted: true,
    })
  })
})
