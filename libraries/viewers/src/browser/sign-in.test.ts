import { describe, expect, it } from "vitest"

import { parsePageSignIn } from "./sign-in.js"

describe("a word of a page's sign-in windows", () => {
  it("is a view's id and how many it has open", () => {
    expect(parsePageSignIn({ contentsId: 7, open: 1, extra: true })).toEqual({
      contentsId: 7,
      open: 1,
    })
    expect(parsePageSignIn({ contentsId: 7, open: 0 })).toEqual({ contentsId: 7, open: 0 })
  })

  it("is refused when either isn't a whole number, or the count is negative", () => {
    for (const value of [
      null,
      "7",
      { contentsId: 7 },
      { contentsId: "7", open: 1 },
      { contentsId: 7.5, open: 1 },
      { contentsId: 7, open: -1 },
      { contentsId: 7, open: 1.5 },
    ])
      expect(parsePageSignIn(value)).toBeNull()
  })
})
