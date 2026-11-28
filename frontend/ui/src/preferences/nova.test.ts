import { describe, expect, it } from "vitest"

import { novaNote } from "./nova"

describe("the Nova row's note", () => {
  it("says nothing while off", () => {
    expect(novaNote(false, { state: "ready" })).toBeUndefined()
    expect(novaNote(false, { state: "off" })).toBeUndefined()
  })

  it("says where the download stands while on", () => {
    expect(
      novaNote(true, { state: "downloading", received: 12_345_678, size: 58_977_130 }),
    ).toEqual({ text: "Downloading Pi: 12.3 of 59.0 MB", error: false })
    expect(novaNote(true, { state: "downloading" })).toEqual({
      text: "Downloading Pi…",
      error: false,
    })
    expect(novaNote(true, { state: "ready" })).toEqual({ text: "Ready.", error: false })
    // Switched on here, before the runner tells.
    expect(novaNote(true, { state: "off" })).toEqual({
      text: "Starting the download…",
      error: false,
    })
  })

  it("gives a failure's reason as an error", () => {
    expect(
      novaNote(true, {
        state: "failed",
        error: "Couldn't reach github.com. Check your connection.",
      }),
    ).toEqual({ text: "Couldn't reach github.com. Check your connection.", error: true })
    expect(novaNote(true, { state: "failed" })).toEqual({
      text: "The download failed.",
      error: true,
    })
  })
})
