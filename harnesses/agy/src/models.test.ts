import { describe, expect, it } from "vitest"

import { agy } from "./index.js"

const install = { env: {}, home: "/home/user", platform: "linux", plugin: "" } as const

describe("Antigravity's models", () => {
  it("are its listed ids, each with the one effort its id ends in", async () => {
    const models = await agy.launch.models(install)
    expect(models).toContainEqual({ id: "gemini-3.8-flash-high", efforts: ["high"] })
    expect(models).toContainEqual({ id: "gemini-3.8-flash-low", efforts: ["low"] })
    expect(models).toContainEqual({ id: "gpt-oss-120b-medium", efforts: ["medium"] })
    expect(models).toContainEqual({ id: "claude-opus-4-6-thinking", efforts: [] })
  })

  it("start with the model and the effort as flags", () => {
    const { choose } = agy.launch
    expect(choose({})).toEqual([])
    expect(choose({ model: "gemini-3.8-flash-low", effort: "low" })).toEqual([
      "--model",
      "gemini-3.8-flash-low",
      "--effort",
      "low",
    ])
  })
})
