import { describe, expect, it } from "vitest"

import { contract } from "./contract.js"

describe("agents.prompt's input", () => {
  const input = contract.agents.prompt["~orpc"].inputSchema!
  const terminalId = "9b2f6d5c-7c1e-4a37-9f3e-1b6c0a4d8e21"
  const path = "/data/uploads/0b6e5c3a-1d2f-4b7a-8c9d-0e1f2a3b4c5d/shot.png"
  const valid = (value: unknown) => input["~standard"].validate(value)

  it("takes text, text with images, and images alone", async () => {
    expect(await valid({ terminalId, text: "Hello" })).not.toHaveProperty("issues")
    expect(await valid({ terminalId, text: "Look", images: [path] })).not.toHaveProperty("issues")
    expect(await valid({ terminalId, text: "", images: [path] })).not.toHaveProperty("issues")
  })

  it("refuses a prompt of nothing, an empty list of images, and more than eight", async () => {
    expect(await valid({ terminalId, text: "" })).toHaveProperty("issues")
    expect(await valid({ terminalId, text: "Look", images: [] })).toHaveProperty("issues")
    expect(
      await valid({ terminalId, text: "Look", images: Array.from({ length: 9 }, () => path) }),
    ).toHaveProperty("issues")
  })
})
