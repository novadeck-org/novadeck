import { describe, expect, it } from "vitest"

import { claude } from "./index.js"

const install = { env: {}, home: "/home/user", platform: "linux", plugin: "" } as const

describe("Claude Code's models", () => {
  it("are its aliases, each with every effort", async () => {
    const models = await claude.launch.models(install)
    expect(models.map(({ id }) => id)).toEqual(["opus", "sonnet", "haiku", "fable"])
    for (const model of models)
      expect(model.efforts).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  it("start with the model and the effort as flags", () => {
    const { choose } = claude.launch
    expect(choose({})).toEqual([])
    expect(choose({ model: "opus", effort: "xhigh" })).toEqual([
      "--model",
      "opus",
      "--effort",
      "xhigh",
    ])
    expect(choose({ model: "sonnet" })).toEqual(["--model", "sonnet"])
  })
})
