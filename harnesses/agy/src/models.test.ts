import { describe, expect, it } from "vitest"

import { agy } from "./index.js"
import { parseModels } from "./models.js"

const install = { env: {}, home: "/home/user", platform: "linux", plugin: "" } as const
const printed =
  "Fetching available models...\ngemini-3.8-flash-high\tFlash High\r\nclaude-opus-4-6-thinking\tClaude Opus 4.6\ngemini-3.8-flash-low\tFlash Low\n\n"

describe("Antigravity's models", () => {
  it("are the ids of the tab-separated lines, each with the one effort its id ends in", () => {
    expect(parseModels(printed)).toEqual([
      { id: "gemini-3.8-flash-high", efforts: ["high"] },
      { id: "claude-opus-4-6-thinking", efforts: [] },
      { id: "gemini-3.8-flash-low", efforts: ["low"] },
    ])
    expect(parseModels("Fetching available models...\n")).toEqual([])
  })

  it("come from running `agy models`, none where that fails", async () => {
    const asked: (readonly string[])[] = []
    const models = await agy.messaging.models(install, (argv) => {
      asked.push(argv)
      return Promise.resolve(printed)
    })
    expect(asked).toEqual([["agy", "models"]])
    expect(models.map(({ id }) => id)).toEqual([
      "gemini-3.8-flash-high",
      "claude-opus-4-6-thinking",
      "gemini-3.8-flash-low",
    ])
    expect(await agy.messaging.models(install, () => Promise.reject(new Error("offline")))).toEqual(
      [],
    )
  })

  it("start with the model and the effort as flags", () => {
    const { choose } = agy.messaging
    expect(choose({})).toEqual([])
    expect(choose({ model: "gemini-3.8-flash-low", effort: "low" })).toEqual([
      "--model",
      "gemini-3.8-flash-low",
      "--effort",
      "low",
    ])
  })
})
