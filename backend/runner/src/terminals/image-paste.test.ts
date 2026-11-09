import { describe, expect, it } from "vitest"

import { imagePaste } from "./image-paste.js"

describe("the paste for an image's path", () => {
  it("leaves a path with nothing in it a shell acts on as it is", () => {
    expect(imagePaste("/home/me/.local/share/novadeck/uploads/0b6e/shot.png")).toBe(
      "/home/me/.local/share/novadeck/uploads/0b6e/shot.png",
    )
  })

  it("puts a backslash before each space, as Codex and Antigravity read a path with one", () => {
    expect(imagePaste("/Users/me/Library/Application Support/novadeck/uploads/0b6e/a b.png")).toBe(
      "/Users/me/Library/Application\\ Support/novadeck/uploads/0b6e/a\\ b.png",
    )
  })

  it("quotes a Windows path with a space, and leaves a plain one", () => {
    expect(imagePaste("C:\\Users\\Jo Doe\\AppData\\uploads\\0b6e\\shot.png")).toBe(
      '"C:\\Users\\Jo Doe\\AppData\\uploads\\0b6e\\shot.png"',
    )
    expect(imagePaste("C:\\Users\\me\\uploads\\0b6e\\shot.png")).toBe(
      "C:\\Users\\me\\uploads\\0b6e\\shot.png",
    )
  })

  it("refuses a path with a control character, which would end the paste", () => {
    expect(() => imagePaste("/tmp/a\nb.png")).toThrow(RangeError)
  })
})
