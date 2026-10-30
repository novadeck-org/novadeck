import type { Refusal } from "@novadeck/core/addons/addon"
import type { MurmurState } from "@novadeck/core/addons/murmur"

import { describe, expect, it } from "../test"
import { footerPhase, footerText, installPercent, stepText } from "./murmur-footer"

const idle: MurmurState = {
  available: true,
  installed: false,
  enabled: false,
  wanted: true,
  sizes: { engine: 100, model: 300 },
  installing: null,
  check: null,
  kept: false,
  unsupported: null,
  offers: 1,
  refused: null,
  failure: null,
  stopped: null,
}
const installing = (
  step: "engine" | "model" | "check",
  received: number,
  origin: "person" | "update" = "person",
): MurmurState => ({
  ...idle,
  installing: {
    step,
    received,
    total: step === "engine" ? 100 : step === "model" ? 300 : 0,
    origin,
  },
})
const checked: MurmurState = {
  ...idle,
  installed: true,
  enabled: true,
  check: { device: "Intel Arc Graphics", integrated: true, milliseconds: 900 },
}
const refusal = (call: Refusal["call"], message = "No."): Refusal => ({ call, message })

describe("Murmur's footer item", () => {
  it("shows an install as it goes, whoever started it from here", () => {
    expect(footerPhase("idle", installing("engine", 10), null)).toBe("installing")
    expect(footerPhase("installing", installing("check", 0), null)).toBe("installing")
  })

  it("ends in done for an install that passed its check", () => {
    expect(footerPhase("installing", checked, null)).toBe("done")
  })

  it("ends in failed with the failure of an install that may pass, and in unavailable when it can't", () => {
    expect(footerPhase("installing", { ...idle, failure: "The download stopped." }, null)).toBe(
      "failed",
    )
    expect(
      footerPhase(
        "installing",
        { ...idle, unsupported: { reason: "No device.", source: "check" } },
        null,
      ),
    ).toBe("unavailable")
  })

  it("leaves when an install is cancelled, as the runner leaves it: files, a check owed, no failure", () => {
    const cancelled: MurmurState = { ...idle, installed: true }
    expect(footerPhase("installing", cancelled, null)).toBe("idle")
    expect(footerPhase("installing", idle, null)).toBe("idle")
  })

  it("shows a refused install from rest, once for each refusal, though the words repeat", () => {
    const first = { ...idle, refused: refusal("install", "Already installing.") }
    expect(footerPhase("idle", first, null)).toBe("failed")
    // Answered: the same refusal is not news, another in the same words is.
    expect(footerPhase("idle", first, first.refused)).toBe("idle")
    const again = { ...idle, refused: refusal("install", "Already installing.") }
    expect(footerPhase("idle", again, first.refused)).toBe("failed")
  })

  it("leaves what the runner says of itself from rest to Addons, except that it stopped", () => {
    for (const state of [
      { ...checked, check: null, failure: "The graphics device went away." },
      { ...checked, failure: "The download stopped: the connection dropped." },
      { ...idle, failure: "The download stopped: the connection dropped." },
      // Not installed: nothing is there to have stopped.
      { ...idle, stopped: "The engine failed to start." },
    ])
      expect(footerPhase("idle", state, null)).toBe("idle")
  })

  it("shows that an installed Murmur stopped from rest, once while it stands", () => {
    const stopped = { ...checked, stopped: "The engine failed to start." }
    expect(footerPhase("idle", stopped, null)).toBe("stopped")
    expect(footerPhase("stopped", stopped, null)).toBe("stopped")
    // Answered with Not now: shut while it stands, whatever its words.
    expect(footerPhase("idle", stopped, null, null, false, true)).toBe("idle")
    expect(
      footerPhase("idle", { ...stopped, stopped: "Another answer." }, null, null, false, true),
    ).toBe("idle")
    // Cleared, the item goes; the caller forgets the answer, so a new one shows.
    expect(footerPhase("stopped", checked, null)).toBe("idle")
    expect(footerPhase("idle", stopped, null, null, false, false)).toBe("stopped")
  })

  it.each(["uninstall", "cancel", "set"] as const)("leaves a refused %s to Addons", (call) => {
    const refused = { ...idle, refused: refusal(call) }
    expect(footerPhase("idle", refused, null)).toBe("idle")
    expect(footerPhase("installing", refused, null)).toBe("idle")
  })

  it("shows nothing for an update's engine fetch, whatever the check holds, and something for a person's", () => {
    const update = (state: MurmurState) => ({
      ...state,
      installing: { step: "engine" as const, received: 1, total: 100, origin: "update" as const },
    })
    expect(footerPhase("idle", update(checked), null)).toBe("idle")
    expect(footerPhase("idle", update({ ...checked, check: null }), null)).toBe("idle")
    // Ended, still no "done": it was never shown.
    expect(footerPhase("idle", checked, null)).toBe("idle")
    // A retry the person started over files that are there.
    const retry = { ...checked, check: null, installing: installing("check", 0).installing }
    expect(footerPhase("idle", retry, null)).toBe("installing")
  })

  it("is not told Not available by a verdict that stood when the install began", () => {
    const standing = { ...idle, unsupported: { reason: "No device.", source: "check" as const } }
    // A Check again that was cancelled, or failed on the network, keeps the old verdict.
    expect(footerPhase("installing", standing, null, "No device.")).toBe("idle")
    expect(
      footerPhase(
        "installing",
        { ...standing, failure: "The download stopped." },
        null,
        "No device.",
      ),
    ).toBe("failed")
    // A verdict that is new is news, whether none stood before or another did.
    expect(footerPhase("installing", standing, null, null)).toBe("unavailable")
    expect(footerPhase("installing", standing, null, "Another reason.")).toBe("unavailable")
  })

  it("leaves a failed item once the runner's failure is cleared, but not one a refusal made", () => {
    const failing = { ...idle, failure: "The download stopped." }
    expect(footerPhase("failed", failing, null, null, true)).toBe("failed")
    // A runner restart, an uninstall or No thanks cleared it.
    expect(footerPhase("failed", idle, null, null, true)).toBe("idle")
    // Another refusal keeps it too.
    expect(footerPhase("failed", { ...idle, refused: refusal("install") }, null, null, true)).toBe(
      "failed",
    )
    // The refusal's own is gone with the next snapshot, and the item waits to be answered.
    expect(footerPhase("failed", idle, null, null, false)).toBe("failed")
  })

  it("counts the download as one, the check as none", () => {
    expect(installPercent(installing("engine", 50))).toBe(13)
    expect(installPercent(installing("model", 150))).toBe(63)
    expect(installPercent(installing("check", 0))).toBeNull()
    expect(installPercent(idle)).toBeNull()
  })

  it("says one stable line to assistive technology, whatever the percent", () => {
    expect(footerText("installing", installing("engine", 10)).label).toBe("Murmur 3%")
    expect(footerText("installing", installing("model", 200)).summary).toBe("Setting up Murmur")
    expect(footerText("installing", installing("engine", 10)).summary).toBe(
      footerText("installing", installing("model", 200)).summary,
    )
    expect(footerText("installing", installing("check", 0)).label).toBe("Murmur")
    expect(footerText("done", checked).label).toBe("Terminals name themselves now")
  })

  it("keeps the failed label short, and says the failure once in the live summary", () => {
    expect(footerText("failed", idle, "The download stopped.").label).toBe("Murmur · failed")
    expect(footerText("failed", idle, "The download stopped.").summary).toBe(
      "Murmur couldn't turn on. The download stopped.",
    )
  })

  it("says the step, never GPU", () => {
    expect(stepText(installing("check", 0))).toBe("Checking this computer")
    expect(stepText(installing("model", 1024 * 1024))).toMatch(/^Downloading model/)
    expect(stepText(idle)).toBe("Starting…")
  })
})
