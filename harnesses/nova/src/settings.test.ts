import { describe, expect, it } from "vitest"

import { novaDefaults, seededSettings } from "./settings.js"

const read = (text: string | undefined) => JSON.parse(text ?? "null") as unknown

describe("Nova's settings", () => {
  it("start a new session on Novadeck's model where there are none", () => {
    expect(read(seededSettings(undefined))).toEqual(novaDefaults)
    expect(read(seededSettings(""))).toEqual(novaDefaults)
    expect(novaDefaults).toEqual({
      defaultProvider: "nova",
      defaultModel: "gpt-6-luna",
      defaultThinkingLevel: "medium",
    })
  })

  it("keep what pi wrote, adding Novadeck's model where they name none", () => {
    const text = JSON.stringify({ lastChangelogVersion: "1.6.0", defaultThinkingLevel: "high" })
    expect(read(seededSettings(text))).toEqual({
      lastChangelogVersion: "1.6.0",
      defaultThinkingLevel: "high",
      defaultProvider: "nova",
      defaultModel: "gpt-6-luna",
    })
  })

  it("change nothing where a model is named, or the file isn't pi's object", () => {
    expect(seededSettings(JSON.stringify({ defaultProvider: "anthropic" }))).toBeUndefined()
    expect(seededSettings(JSON.stringify({ defaultModel: "x" }))).toBeUndefined()
    expect(seededSettings("{ not json")).toBeUndefined()
    expect(seededSettings("[1]")).toBeUndefined()
  })
})
