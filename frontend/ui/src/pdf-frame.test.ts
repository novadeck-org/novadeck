import { readFileSync } from "node:fs"

import { describe, expect, it } from "./test"

// The PDF viewer's frame page, which every app serves from this public folder beside its own
// page: the viewers library's own (libraries/viewers/src/pdf/frame.html), byte for byte, as its
// policy names its script by its hash.
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

describe("the PDF viewer's frame page", () => {
  it("is served as the viewers library writes it", () => {
    expect(read("../public/pdf-frame.html")).toBe(
      read("../../../libraries/viewers/src/pdf/frame.html"),
    )
  })
})
