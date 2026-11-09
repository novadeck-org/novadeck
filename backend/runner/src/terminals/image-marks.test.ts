import { describe, expect, it } from "../test.js"
import { splitImages } from "./image-marks.js"

describe("the images in a box's text", () => {
  it("counts the placeholders that lead and leaves the words", () => {
    expect(splitImages("[Image #1] [Image #2] Compare them")).toEqual({
      words: "Compare them",
      marks: 2,
      places: [0, 0],
    })
    expect(splitImages("[Image #4]")).toEqual({ words: "", marks: 1, places: [0] })
  })

  it("tells where each placeholder stood among the words, white space not counted", () => {
    expect(splitImages("See this: [Image #1] and fix it")).toEqual({
      words: "See this:  and fix it",
      marks: 1,
      places: [8],
    })
    // Codex keeps a space of its own after a placeholder: the place is the same.
    expect(splitImages("See this: [Image #1]  and fix it")).toMatchObject({ marks: 1, places: [8] })
    expect(splitImages("Compare [Image #1] with [Image #2]")).toMatchObject({
      words: "Compare  with",
      marks: 2,
      places: [7, 11],
    })
    expect(splitImages("Look at [Image #1]")).toMatchObject({ words: "Look at", places: [6] })
  })

  it("tells words with no placeholder in them", () => {
    expect(splitImages("plain words")).toEqual({ words: "plain words", marks: 0, places: [] })
  })
})
