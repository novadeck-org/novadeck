import { describe, expect, it } from "../test.js"
import { splitImages } from "./image-marks.js"

describe("the images that lead a box's text", () => {
  it("counts the placeholders and leaves the words", () => {
    expect(splitImages("[Image #1] [Image #2] Compare them")).toEqual({
      words: "Compare them",
      marks: 2,
    })
    expect(splitImages("[Image #4]")).toEqual({ words: "", marks: 1 })
  })

  it("leaves a text with a placeholder in the middle of it whole", () => {
    expect(splitImages("Look at [Image #1]")).toEqual({ words: "Look at [Image #1]", marks: 0 })
  })
})
