import { describe, expect, it } from "../../test"
import { answersText, completion, targetOf } from "./path-field"

describe("the path a field opens", () => {
  it("is the text trimmed and without separators at its end, the POSIX root whole", () => {
    expect(targetOf("  /tmp/render/ ")).toBe("/tmp/render")
    expect(targetOf("~/Downloads//")).toBe("~/Downloads")
    expect(targetOf("/")).toBe("/")
    expect(targetOf("")).toBe("")
  })

  it("keeps a drive's root whole, which `C:` alone is not", () => {
    expect(targetOf("C:\\")).toBe("C:\\")
    expect(targetOf("d:/")).toBe("d:/")
    expect(targetOf("C:\\\\")).toBe("C:\\")
    expect(targetOf("C:\\Users\\me\\")).toBe("C:\\Users\\me")
    expect(targetOf("C:")).toBe("C:")
  })

  it("completes into a folder with the separator its path is written with", () => {
    expect(completion("/tmp/render")).toBe("/tmp/render/")
    expect(completion("C:\\Users")).toBe("C:\\Users\\")
    expect(completion("/tmp/render/")).toBe("/tmp/render/")
  })
})

describe("a folder named for what was typed", () => {
  it("continues the text, in any case, by a name alone", () => {
    expect(answersText("/tmp/render", "/tmp/re")).toBe(true)
    expect(answersText("/tmp/Render", "/tmp/re")).toBe(true)
    expect(answersText("~/Downloads", "~")).toBe(true)
    expect(answersText("/tmp/render", "/tmp/")).toBe(true)
  })

  it("is not an answer to another prefix, or a folder deeper than the text", () => {
    expect(answersText("/tmp/release", "/tmp/ren")).toBe(false)
    expect(answersText("~/Desktop", "~/Dow")).toBe(false)
    expect(answersText("/tmp/render/frames", "/tmp/re")).toBe(false)
  })
})
