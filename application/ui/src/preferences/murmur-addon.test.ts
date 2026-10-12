import { describe, expect, it } from "vitest"

import type { MurmurState } from "../model/murmur"
import { deviceText, murmurInstallSize } from "./murmur-addon"

const state: MurmurState = {
  available: true,
  installed: false,
  enabled: false,
  wanted: true,
  sizes: { engine: 34 * 1024 * 1024, model: 1222 * 1024 * 1024 },
  installing: null,
  check: null,
  failure: null,
}

describe("murmur's card", () => {
  it("counts the engine and the model in what an install downloads", () => {
    expect(murmurInstallSize(state)).toBe(1256 * 1024 * 1024)
  })

  it("names the device it runs on", () => {
    expect(
      deviceText({
        device: "Intel Arc Graphics",
        integrated: true,
        milliseconds: 5000,
      }),
    ).toBe("Runs on Intel Arc Graphics.")
  })
})
