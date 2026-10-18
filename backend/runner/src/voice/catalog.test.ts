import { describe, expect, it } from "../test.js"
import { catalog, recommend } from "./catalog.js"

describe("the voice catalog", () => {
  it("pins every download by commit and checksum", () => {
    for (const artifact of [...Object.values(catalog.models), catalog.vad]) {
      expect(artifact.url).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//)
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe("the recommended model", () => {
  it("is turbo for a GPU that does the test clip in four seconds", () => {
    expect(recommend({ gpu: true, milliseconds: 4000 })).toBe("turbo")
  })

  it("is small for a GPU that is slower than that", () => {
    expect(recommend({ gpu: true, milliseconds: 4001 })).toBe("small")
  })

  it("is small without a GPU, however quick", () => {
    expect(recommend({ gpu: false, milliseconds: 100 })).toBe("small")
  })
})
