import { describe, expect, it } from "vitest"

import type { VoiceState } from "../model/voice"
import { formatSize, installedSize, installSize, recommendation } from "./voice-addon"

const megabyte = 1024 * 1024
const state: VoiceState = {
  available: true,
  installed: [],
  enabled: false,
  model: "turbo",
  language: "auto",
  sizes: { engine: 28 * megabyte, turbo: 1600 * megabyte, small: 190 * megabyte },
  installing: null,
  check: null,
  failure: null,
}

describe("voice input sizes", () => {
  it("name megabytes, and gigabytes from one up", () => {
    expect(formatSize(190 * megabyte)).toBe("190 MB")
    expect(formatSize(1600 * megabyte)).toBe("1.6 GB")
    expect(formatSize(10)).toBe("1 MB")
    expect(formatSize(0)).toBe("0 MB")
  })

  it("count the engine in an install only until it is there", () => {
    expect(installSize(state, "small")).toBe(218 * megabyte)
    expect(installSize({ ...state, installed: ["turbo"] }, "small")).toBe(190 * megabyte)
  })

  it("count the engine and every installed model in what an uninstall frees", () => {
    expect(installedSize({ ...state, installed: ["turbo", "small"] })).toBe(1818 * megabyte)
  })
})

describe("the voice input recommendation", () => {
  const check = { model: "turbo", milliseconds: 9000, gpu: false, recommended: "small" } as const

  it("is silent when the model in use is the one that suits", () => {
    expect(recommendation({ ...state, check: { ...check, recommended: "turbo" } })).toBeUndefined()
  })

  it("points at installing, or switching to, the model that suits", () => {
    expect(recommendation({ ...state, installed: ["turbo"], check })).toMatch(/install it/)
    expect(recommendation({ ...state, installed: ["turbo", "small"], check })).toMatch(/switch/)
  })
})
