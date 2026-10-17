import { afterEach, beforeEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { createDemoMurmur, heldMurmurTiming } from "./murmur"

describe("the demo's murmur", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("holds a held install at its engine however long it waits, until a cancel leaves nothing", async () => {
    const murmur = createDemoMurmur(heldMurmurTiming, "uninstalled")
    murmur.install()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(murmur.state.getSnapshot().installing).toMatchObject({ step: "engine" })
    murmur.cancel()
    // Nothing of it resumes, however long after.
    await vi.advanceTimersByTimeAsync(10 * 400_000_000)
    expect(murmur.state.getSnapshot()).toMatchObject({ installing: null, installed: false })
  })

  it("installs through the engine, the model and a check, then turns on", async () => {
    const murmur = createDemoMurmur({ step: 100, device: "Intel Arc Graphics" }, "uninstalled")
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

  context("on a computer that can't run it", () => {
    it("ends the install in Not available, with the downloads removed", async () => {
      const murmur = createDemoMurmur({ step: 100, device: null }, "uninstalled")
      murmur.install()
      await vi.advanceTimersByTimeAsync(400)
      expect(murmur.state.getSnapshot()).toMatchObject({
        installing: null,
        installed: false,
        enabled: false,
        check: null,
        failure: null,
        unsupported: { reason: expect.stringMatching(/graphics device/), source: "check" },
      })
    })

    it("checks anew on another try, which ends the same way here", async () => {
      const murmur = createDemoMurmur({ step: 100, device: null }, "uninstalled")
      murmur.install()
      await vi.advanceTimersByTimeAsync(400)
      murmur.install()
      await vi.advanceTimersByTimeAsync(50)
      expect(murmur.state.getSnapshot()).toMatchObject({ installing: { step: "engine" } })
      await vi.advanceTimersByTimeAsync(400)
      expect(murmur.state.getSnapshot()).toMatchObject({
        installed: false,
        unsupported: { source: "check" },
      })
    })

    it("keeps a check's verdict while it checks again, until a check passes, and refuses the host's", async () => {
      const murmur = createDemoMurmur({ step: 100, device: "Intel Arc Graphics" }, "unsupported")
      void murmur.install()
      await vi.advanceTimersByTimeAsync(50)
      expect(murmur.state.getSnapshot()).toMatchObject({
        installing: { origin: "person" },
        unsupported: { source: "check" },
      })
      await vi.advanceTimersByTimeAsync(400)
      expect(murmur.state.getSnapshot()).toMatchObject({ installed: true, unsupported: null })

      murmur.show("unsupported-host")
      await murmur.install()
      expect(murmur.state.getSnapshot().refused).toMatchObject({ call: "install" })
      expect(murmur.state.getSnapshot().installing).toBeNull()
    })

    it("starts Not available when asked to", () => {
      const murmur = createDemoMurmur(undefined, "unsupported")
      expect(murmur.state.getSnapshot()).toMatchObject({
        installed: false,
        unsupported: { reason: expect.stringMatching(/Vulkan/), source: "check" },
        // Not a decline: murmur is still wanted, only not here.
        wanted: true,
      })
    })
  })

  it("starts installed and on, so the try demo never offers it", () => {
    expect(createDemoMurmur().state.getSnapshot()).toMatchObject({
      installed: true,
      enabled: true,
      wanted: true,
      check: { device: "Intel Arc Graphics" },
      unsupported: null,
    })
  })

  context("for the debug panel", () => {
    it("shows a network failure that is no decline, after an install that was running, and a held install", async () => {
      const murmur = createDemoMurmur()
      murmur.show("network-failure")
      expect(murmur.state.getSnapshot().installing).toMatchObject({ step: "model" })
      await vi.advanceTimersByTimeAsync(2000)
      expect(murmur.state.getSnapshot()).toMatchObject({
        installed: false,
        wanted: true,
        failure: expect.stringMatching(/connection dropped/),
      })
      murmur.show("installing")
      expect(murmur.state.getSnapshot().installing).toMatchObject({ step: "model" })
    })

    it("shows a verdict beside files that stayed, installed but unchecked", () => {
      const murmur = createDemoMurmur()
      murmur.show("unsupported-with-files")
      expect(murmur.state.getSnapshot()).toMatchObject({
        installed: true,
        check: null,
        enabled: false,
        unsupported: expect.objectContaining({ source: "check" }),
      })
    })

    it("walks an install to done, and to Not available, as the footer item follows", async () => {
      const murmur = createDemoMurmur()
      murmur.show("done")
      expect(murmur.state.getSnapshot().installing).toMatchObject({ step: "check" })
      await vi.advanceTimersByTimeAsync(2000)
      expect(murmur.state.getSnapshot()).toMatchObject({ installed: true, installing: null })

      murmur.show("unavailable-after-check")
      expect(murmur.state.getSnapshot().installing).toMatchObject({ step: "check" })
      await vi.advanceTimersByTimeAsync(2000)
      expect(murmur.state.getSnapshot()).toMatchObject({
        installed: false,
        unsupported: expect.objectContaining({ reason: expect.any(String) }),
      })
    })

    it("asks the app to offer the chip, from a computer where it is not installed", () => {
      const murmur = createDemoMurmur()
      const before = murmur.offer.getSnapshot()
      murmur.show("offer")
      expect(murmur.offer.getSnapshot()).toBe(before + 1)
      expect(murmur.state.getSnapshot()).toMatchObject({ installed: false, wanted: true })
    })

    it("counts the sessions the offer was shown in, and keeps the count through every scenario", () => {
      const murmur = createDemoMurmur(undefined, "uninstalled")
      murmur.noteOffered()
      murmur.noteOffered()
      expect(murmur.state.getSnapshot().offers).toBe(2)
      murmur.show("installing")
      murmur.show("network-failure")
      expect(murmur.state.getSnapshot().offers).toBe(2)
      expect(createDemoMurmur(undefined, "offered-out").state.getSnapshot().offers).toBe(3)
    })

    it("shows the host's software-rendering verdict with nothing to check again", () => {
      const murmur = createDemoMurmur()
      murmur.show("unsupported-host")
      expect(murmur.state.getSnapshot()).toMatchObject({
        unsupported: { reason: expect.stringMatching(/software rendering/), source: "host" },
      })
    })

    it("makes the next install end Not available, and puts it back", async () => {
      const murmur = createDemoMurmur({ step: 100, device: "Intel Arc Graphics" })
      murmur.show("unsupported-after-install")
      murmur.install()
      await vi.advanceTimersByTimeAsync(400)
      expect(murmur.state.getSnapshot().unsupported).not.toBeNull()
      murmur.show("uninstalled")
      murmur.install()
      await vi.advanceTimersByTimeAsync(400)
      expect(murmur.state.getSnapshot()).toMatchObject({ installed: true, unsupported: null })
    })
  })

  it("leaves the files and a check owed, no failure, when the check is cancelled", async () => {
    const murmur = createDemoMurmur({ step: 100, device: "GPU" }, "uninstalled")
    murmur.install()
    await vi.advanceTimersByTimeAsync(250)
    expect(murmur.state.getSnapshot().installing?.step).toBe("check")
    murmur.cancel()
    expect(murmur.state.getSnapshot()).toMatchObject({
      installing: null,
      installed: true,
      check: null,
      failure: null,
    })
  })

  it("stops an install on cancel", async () => {
    const murmur = createDemoMurmur({ step: 100, device: "GPU" }, "uninstalled")
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
    const murmur = createDemoMurmur({ step: 100, device: "GPU" }, "uninstalled")
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
    const murmur = createDemoMurmur({ step: 100, device: "GPU" }, "uninstalled")
    murmur.set({ enabled: true })
    expect(murmur.state.getSnapshot()).toMatchObject({
      installed: false,
      enabled: false,
      wanted: true,
    })
  })
})
