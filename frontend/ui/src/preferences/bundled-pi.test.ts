import { describe, expect, it } from "vitest"

import { bundledPiNote } from "./bundled-pi"

describe("the Novadeck Agent row's note", () => {
  it("says nothing while off", () => {
    expect(bundledPiNote(false, { state: "ready" })).toBeUndefined()
    expect(bundledPiNote(false, { state: "off" })).toBeUndefined()
  })

  it("says where the download stands while on", () => {
    expect(
      bundledPiNote(true, { state: "downloading", received: 12_345_678, size: 58_977_130 }),
    ).toEqual({ text: "Downloading pi: 12.3 of 59.0 MB", error: false })
    expect(bundledPiNote(true, { state: "downloading" })).toEqual({
      text: "Downloading pi…",
      error: false,
    })
    expect(bundledPiNote(true, { state: "ready" })).toEqual({ text: "Ready.", error: false })
    // Switched on here, before the runner tells.
    expect(bundledPiNote(true, { state: "off" })).toEqual({
      text: "Starting the download…",
      error: false,
    })
  })

  it("gives a failure's reason as an error", () => {
    expect(
      bundledPiNote(true, {
        state: "failed",
        error: "Could not reach github.com. Check the connection.",
      }),
    ).toEqual({ text: "Could not reach github.com. Check the connection.", error: true })
    expect(bundledPiNote(true, { state: "failed" })).toEqual({
      text: "The download failed.",
      error: true,
    })
  })
})
