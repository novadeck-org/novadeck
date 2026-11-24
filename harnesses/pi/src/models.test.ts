import { describe, expect, it } from "vitest"

import { choose, parseModels } from "./models.js"

describe("pi's models, as Novadeck's extension writes them", () => {
  it("offers each model by provider and id, with the efforts among its thinking levels", () => {
    const written = JSON.stringify([
      {
        provider: "anthropic",
        id: "claude-opus-5-5",
        levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      },
      { provider: "openai", id: "gpt-6", levels: ["off", "minimal", "low", "medium", "high"] },
      { provider: "local", id: "tiny", levels: ["off"] },
    ])
    expect(parseModels(written)).toEqual([
      { id: "anthropic/claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "openai/gpt-6", efforts: ["low", "medium", "high"] },
      { id: "local/tiny", efforts: [] },
    ])
  })

  it("leaves out what a shell couldn't take as a word, and any it lists twice", () => {
    const written = JSON.stringify([
      { provider: "openrouter", id: "x[1m]", levels: [] },
      { provider: "openai", id: "gpt-6", levels: [] },
      { provider: "openai", id: "gpt-6", levels: [] },
    ])
    expect(parseModels(written).map((model) => model.id)).toEqual(["openai/gpt-6"])
  })

  it("has none before pi ran once in Novadeck, nor from a file it can't read", () => {
    expect(parseModels("")).toEqual([])
    expect(parseModels("{")).toEqual([])
  })

  it("starts pi on a model and an effort with its own flags", () => {
    expect(choose({ model: "openai/gpt-6", effort: "high" })).toEqual([
      "--model",
      "openai/gpt-6",
      "--thinking",
      "high",
    ])
    expect(choose({})).toEqual([])
  })
})
